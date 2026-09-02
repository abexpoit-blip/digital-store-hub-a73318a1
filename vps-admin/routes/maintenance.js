// Maintenance Manager — web panel থেকে bot maintenance mode ON/OFF + message,
// service-wise toggle (buy / deposit / vpn / replace), DB health + pm2 controls.
const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const { db, logAudit, DB_PATH } = require('../db');
const router = express.Router();

const BOT_PM2 = process.env.BOT_PM2_NAME || 'nexus-bot';
const ADMIN_PM2 = process.env.PM2_NAME || 'nexusx-admin';

const OFF_VALUES = ['0', 'off', 'false', 'no', 'closed', 'disabled'];

const DEFAULT_MSG =
  '🛠 সিস্টেম আপডেট চলছে\n\nআমরা কিছু জরুরি কাজ করছি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।\nআপনার ব্যালান্স ও অর্ডার সম্পূর্ণ নিরাপদ আছে। ধন্যবাদ 🙏';

// Toggles shown on the page: [config key, label, help]
const SERVICE_TOGGLES = [
  ['buy_service_enabled', '🛒 ID কেনা (Buy)', 'বন্ধ করলে user কোনো ID কিনতে পারবে না'],
  ['deposit_service_enabled', '💰 Deposit / Add Balance', 'বন্ধ করলে নতুন payment তৈরি হবে না'],
  ['vpn_service_enabled', '🛡 VPN Service', 'বন্ধ করলে VPN section unavailable দেখাবে'],
  ['replace_service_enabled', '🔄 Replace Request', 'বন্ধ করলে নতুন replace request নেওয়া হবে না'],
];

function run(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
    });
  });
}

function cfgGet(key, def) {
  try {
    const r = db.prepare('SELECT value FROM config WHERE key=?').get(key);
    return r && r.value != null ? String(r.value) : def;
  } catch (_) { return def; }
}
function cfgSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}
const isOn = (v) => !OFF_VALUES.includes(String(v == null ? 'on' : v).toLowerCase());

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return null; }
}
function human(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

async function pm2Status() {
  const r = await run('pm2 jlist');
  let list = [];
  try { list = JSON.parse(r.out || '[]'); } catch (_) { list = []; }
  return [BOT_PM2, ADMIN_PM2].map((name) => {
    const p = list.find((x) => x.name === name);
    if (!p) return { name, found: false };
    const env = p.pm2_env || {};
    return {
      name,
      found: true,
      status: env.status || '?',
      restarts: env.restart_time || 0,
      uptime: env.pm_uptime ? Math.floor((Date.now() - env.pm_uptime) / 1000) : 0,
      cpu: (p.monit && p.monit.cpu) || 0,
      mem: human((p.monit && p.monit.memory) || 0),
    };
  });
}

function fmtUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

router.get('/', async (req, res, next) => {
  try {
    const maintOn = isOn(cfgGet('maintenance_mode', 'off')) && cfgGet('maintenance_mode', 'off') !== 'off';
    const on = String(cfgGet('maintenance_mode', 'off')).toLowerCase();
    const maintenanceOn = ['1', 'on', 'true', 'yes'].includes(on);

    const toggles = SERVICE_TOGGLES.map(([key, label, help]) => ({
      key, label, help, on: isOn(cfgGet(key, 'on')),
    }));

    const procs = (await pm2Status()).map((p) => ({ ...p, uptimeText: fmtUptime(p.uptime) }));

    const wal = DB_PATH ? `${DB_PATH}-wal` : null;
    const dbInfo = {
      path: DB_PATH,
      size: human(fileSize(DB_PATH)),
      wal: human(wal ? fileSize(wal) : null),
      journal: (() => { try { return db.pragma('journal_mode', { simple: true }); } catch (_) { return '?'; } })(),
    };

    res.render('maintenance', {
      maintenanceOn: maintenanceOn || (maintOn && on === 'on'),
      message: cfgGet('maintenance_msg', DEFAULT_MSG),
      since: parseInt(cfgGet('maintenance_since', '0'), 10) || 0,
      toggles, procs, dbInfo,
      botPm2: BOT_PM2, adminPm2: ADMIN_PM2,
      msg: req.query.msg || null,
    });
  } catch (e) { next(e); }
});

// Maintenance mode ON / OFF
router.post('/toggle', (req, res) => {
  const next = req.body.state === 'on' ? 'on' : 'off';
  cfgSet('maintenance_mode', next);
  cfgSet('maintenance_since', next === 'on' ? Math.floor(Date.now() / 1000) : 0);
  logAudit('admin', 'maintenance_toggle', next);
  res.redirect('/maintenance?msg=' + encodeURIComponent(next === 'on'
    ? '🛠 Maintenance ON — user রা maintenance message পাবে (admin রা স্বাভাবিক ব্যবহার করতে পারবে)'
    : '✅ Maintenance OFF — bot স্বাভাবিক চালু'));
});

// Maintenance message
router.post('/message', (req, res) => {
  const text = String(req.body.message || '').trim();
  if (!text) return res.redirect('/maintenance?msg=' + encodeURIComponent('❌ Message খালি রাখা যাবে না'));
  if (text.length > 2000) return res.redirect('/maintenance?msg=' + encodeURIComponent('❌ Message 2000 অক্ষরের কম হতে হবে'));
  cfgSet('maintenance_msg', text);
  logAudit('admin', 'maintenance_msg', `len=${text.length}`);
  res.redirect('/maintenance?msg=' + encodeURIComponent('✅ Maintenance message সেভ হয়েছে'));
});

router.post('/message/reset', (req, res) => {
  cfgSet('maintenance_msg', DEFAULT_MSG);
  logAudit('admin', 'maintenance_msg', 'reset to default');
  res.redirect('/maintenance?msg=' + encodeURIComponent('✅ Default message ফিরে এসেছে'));
});

// Individual service toggle
router.post('/service', (req, res) => {
  const key = String(req.body.key || '');
  const allowed = SERVICE_TOGGLES.map((t) => t[0]);
  if (!allowed.includes(key)) {
    return res.redirect('/maintenance?msg=' + encodeURIComponent('❌ অজানা service'));
  }
  const next = req.body.state === 'on' ? 'on' : 'off';
  cfgSet(key, next);
  logAudit('admin', 'service_toggle', `${key}=${next}`);
  res.redirect('/maintenance?msg=' + encodeURIComponent(`${next === 'on' ? '✅ চালু' : '⛔ বন্ধ'}: ${key}`));
});

// pm2 restart (bot / admin)
router.post('/restart', async (req, res) => {
  const target = req.body.target === 'admin' ? ADMIN_PM2 : BOT_PM2;
  const r = await run(`pm2 restart ${target}`, 20000);
  logAudit('admin', 'pm2_restart', target);
  res.redirect('/maintenance?msg=' + encodeURIComponent(r.ok ? `✅ Restarted: ${target}` : `❌ ${r.err || 'restart fail'}`));
});

// DB maintenance: shrink WAL
router.post('/checkpoint', (req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    logAudit('admin', 'db_checkpoint', 'wal truncate');
    res.redirect('/maintenance?msg=' + encodeURIComponent('✅ WAL checkpoint সম্পন্ন — database ফাইল ছোট হলো'));
  } catch (e) {
    res.redirect('/maintenance?msg=' + encodeURIComponent('❌ ' + e.message));
  }
});

router.post('/optimize', (req, res) => {
  try {
    db.pragma('optimize');
    logAudit('admin', 'db_optimize', 'pragma optimize');
    res.redirect('/maintenance?msg=' + encodeURIComponent('✅ Database optimize হয়েছে'));
  } catch (e) {
    res.redirect('/maintenance?msg=' + encodeURIComponent('❌ ' + e.message));
  }
});

module.exports = router;
