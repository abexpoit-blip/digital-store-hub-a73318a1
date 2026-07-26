// Manual balance credit tracking — who got admin-given balance, how often
const express = require('express');
const { db } = require('../db');
const router = express.Router();

function fmtDate(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  } catch (_) { return '-'; }
}

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const days = parseInt(req.query.days, 10) || 0; // 0 = all time

  let where = ' WHERE 1=1';
  const params = [];
  if (q) {
    where += ' AND (LOWER(COALESCE(mc.username,\'\')) LIKE ? OR CAST(mc.user_id AS TEXT) LIKE ?)';
    params.push(`%${q.toLowerCase()}%`, `%${q}%`);
  }
  if (days > 0) {
    where += ' AND mc.created_at >= ?';
    params.push(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  let rows = [];
  let top = [];
  const stats = { count: 0, added: 0, removed: 0, users: 0 };
  try {
    rows = db.prepare(
      `SELECT mc.* FROM manual_credits mc${where} ORDER BY mc.id DESC LIMIT 500`
    ).all(...params);
    rows.forEach(r => { r._date = fmtDate(r.created_at); });

    top = db.prepare(
      `SELECT mc.user_id, MAX(COALESCE(mc.username,'')) AS username,
              COUNT(*) AS times,
              SUM(CASE WHEN mc.delta > 0 THEN mc.delta ELSE 0 END) AS added,
              SUM(CASE WHEN mc.delta < 0 THEN -mc.delta ELSE 0 END) AS removed,
              MAX(mc.created_at) AS last_at
         FROM manual_credits mc${where}
        GROUP BY mc.user_id
        ORDER BY times DESC, added DESC
        LIMIT 50`
    ).all(...params);
    top.forEach(t => { t._last = fmtDate(t.last_at); });

    stats.count = rows.length;
    rows.forEach(r => {
      if (r.delta > 0) stats.added += r.delta; else stats.removed += -r.delta;
    });
    stats.users = top.length;
  } catch (e) {
    console.warn('[credits] query failed:', e.message);
  }

  res.render('credits', { rows, top, stats, q, days, msg: req.query.msg || null });
});

module.exports = router;
