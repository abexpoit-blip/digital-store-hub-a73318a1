// Buy Limit Manager — web panel থেকে FB 1000xx purchase limit ON/OFF + value control.
// Bot একই store.db এর config table live পড়ে, তাই change সাথে সাথেই apply হয়।
const express = require('express');
const { db, logAudit } = require('../db');
const router = express.Router();

const DEFAULT_CATS = 'fb1000, fb1000xx, 1000xx';

try {
  db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS buy_limit (
    user_id INTEGER PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0);`);
} catch (e) { console.warn('[buylimit] table init:', e.message); }

function cfg(key, fallback) {
  try {
    const r = db.prepare('SELECT value FROM config WHERE key=?').get(key);
    return r && r.value != null && String(r.value).trim() !== '' ? String(r.value) : fallback;
  } catch (_) { return fallback; }
}
function setCfg(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}
const OFF = ['0', 'off', 'false', 'no', 'disabled', 'closed'];

function settings() {
  const enabled = !OFF.includes(String(cfg('buylimit_enabled', 'on')).toLowerCase());
  const max = parseInt(cfg('buylimit_max', '10'), 10) || 10;
  const windowMin = parseInt(cfg('buylimit_window_min', '10'), 10) || 10;
  const cats = cfg('buylimit_cats', DEFAULT_CATS);
  return { enabled, max, windowMin, cats };
}

router.get('/', (req, res) => {
  const s = settings();
  const now = Math.floor(Date.now() / 1000);
  let active = [];
  try {
    active = db.prepare(
      `SELECT b.user_id, b.window_start, b.count, u.username
         FROM buy_limit b LEFT JOIN users u ON u.user_id = b.user_id
        WHERE b.window_start > ?
        ORDER BY b.window_start DESC LIMIT 25`
    ).all(now - s.windowMin * 60).map((r) => ({
      ...r,
      left: Math.max(0, s.windowMin * 60 - (now - r.window_start)),
    }));
  } catch (e) { console.warn('[buylimit] list:', e.message); }

  res.render('buylimit', { title: 'Buy Limit', ...s, active, msg: req.query.msg || null });
});

// Global ON / OFF
router.post('/toggle', (req, res) => {
  const next = req.body.state === 'off' ? 'off' : 'on';
  setCfg('buylimit_enabled', next);
  logAudit('admin', 'buylimit_toggle', next);
  res.redirect('/buylimit?msg=' + encodeURIComponent(next === 'on'
    ? '✅ Buy limit চালু হলো'
    : '⛔ Buy limit বন্ধ — এখন unlimited কেনা যাবে'));
});

// Save values
router.post('/save', (req, res) => {
  const max = parseInt(req.body.max, 10);
  const windowMin = parseInt(req.body.window_min, 10);
  const cats = String(req.body.cats || '')
    .split(/[\s,\n]+/).map((c) => c.trim().toLowerCase()).filter(Boolean);

  if (!Number.isFinite(max) || max < 1 || max > 100000) {
    return res.redirect('/buylimit?msg=' + encodeURIComponent('❌ Max pcs 1-100000 হতে হবে'));
  }
  if (!Number.isFinite(windowMin) || windowMin < 1 || windowMin > 1440) {
    return res.redirect('/buylimit?msg=' + encodeURIComponent('❌ Window 1-1440 মিনিট হতে হবে'));
  }
  if (!cats.length) {
    return res.redirect('/buylimit?msg=' + encodeURIComponent('❌ কমপক্ষে একটা category দিন'));
  }
  setCfg('buylimit_max', max);
  setCfg('buylimit_window_min', windowMin);
  setCfg('buylimit_cats', cats.join(', '));
  logAudit('admin', 'buylimit_settings', `${max} pcs / ${windowMin} min · ${cats.join(',')}`);
  res.redirect('/buylimit?msg=' + encodeURIComponent(`✅ সেভ হলো: ${max} pcs / ${windowMin} মিনিট`));
});

// Reset one user's window
router.post('/reset', (req, res) => {
  const uid = parseInt(req.body.user_id, 10);
  if (!Number.isFinite(uid)) {
    return res.redirect('/buylimit?msg=' + encodeURIComponent('❌ User id ভুল'));
  }
  const r = db.prepare('DELETE FROM buy_limit WHERE user_id=?').run(uid);
  logAudit('admin', 'buylimit_reset', `user=${uid} removed=${r.changes}`);
  res.redirect('/buylimit?msg=' + encodeURIComponent(r.changes
    ? `♻️ ${uid} এর limit reset হলো`
    : '❌ ওই user এর active window নেই'));
});

// Reset everyone
router.post('/reset-all', (req, res) => {
  const r = db.prepare('DELETE FROM buy_limit').run();
  logAudit('admin', 'buylimit_reset_all', `rows=${r.changes}`);
  res.redirect('/buylimit?msg=' + encodeURIComponent(`♻️ সবার limit reset হলো (${r.changes})`));
});

module.exports = router;
