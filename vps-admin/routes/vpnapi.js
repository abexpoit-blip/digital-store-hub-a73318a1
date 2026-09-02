// VPN Provider API — sync brand / package / days info from the reseller API.
// Provider: https://vpn.sajeebtechonline.top/api.php  (actions: services, balance, order, status)
// NOTE: This page only syncs catalog info (brand, package, days, availability).
//       Selling price is NOT touched here — price is managed in /vpn.
const express = require('express');
const https = require('https');
const { URL } = require('url');
const { db, logAudit } = require('../db');
const router = express.Router();

const DEFAULT_API_URL = 'https://vpn.sajeebtechonline.top/api.php';

// ---------- schema ----------
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vpn_api_services (
      service          TEXT PRIMARY KEY,
      name             TEXT,
      category         TEXT,
      type             TEXT,
      days             INTEGER,
      pkg_id           TEXT,
      vpn_id           TEXT,
      rate             REAL,
      original_rate    REAL,
      discount_percent REAL,
      min_qty          INTEGER,
      max_qty          INTEGER,
      available        INTEGER DEFAULT 1,
      raw              TEXT,
      updated_at       INTEGER
    );
  `);
} catch (e) { console.warn('[vpnapi] table init:', e.message); }

// ---------- config helpers ----------
function cfgGet(key, def) {
  try {
    const r = db.prepare('SELECT value FROM config WHERE key=?').get(key);
    return r && r.value != null ? String(r.value) : def;
  } catch (_) { return def; }
}
function cfgSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getApiConf() {
  return {
    url: cfgGet('vpnapi_url', process.env.VPN_API_URL || DEFAULT_API_URL),
    key: cfgGet('vpnapi_key', process.env.VPN_API_KEY || ''),
  };
}

// ---------- provider call (node https, no extra deps) ----------
function apiCall(action, extra = {}) {
  const { url, key } = getApiConf();
  return new Promise((resolve, reject) => {
    if (!key) return reject(new Error('API Key সেট করা নেই'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('API URL ভুল')); }

    const params = new URLSearchParams({ action, key, ...extra });
    const body = params.toString();
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; if (raw.length > 2_000_000) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (_) { reject(new Error('Provider থেকে অবৈধ response: ' + raw.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Provider timeout (30s)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- parsing helpers ----------
// "3 Days VPN" -> { days: 3, pkg_id: '3d' } ; "1 Month" -> { days: 30, pkg_id: '1m' }
function parseDuration(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/(\d+)\s*(day|days|d)\b/);
  if (m) return { days: +m[1], pkg_id: `${+m[1]}d` };
  m = s.match(/(\d+)\s*(month|months|mo|m)\b/);
  if (m) return { days: +m[1] * 30, pkg_id: `${+m[1]}m` };
  m = s.match(/(\d+)\s*(year|years|yr|y)\b/);
  if (m) return { days: +m[1] * 365, pkg_id: `${+m[1]}y` };
  m = s.match(/(\d+)\s*(week|weeks|w)\b/);
  if (m) return { days: +m[1] * 7, pkg_id: `${+m[1] * 7}d` };
  return { days: null, pkg_id: null };
}

// "Cyberghost" -> "cyberghost" (safe id for our vpn_packages table)
function slugBrand(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/vpn/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20) || 'unknown';
}

function fmtPkg(pkg_id) {
  const p = String(pkg_id || '').toLowerCase();
  if (/^\d+d$/.test(p)) return `${p.slice(0, -1)} Days`;
  if (/^\d+m$/.test(p)) return `${p.slice(0, -1)} Months`;
  if (/^\d+y$/.test(p)) return `${p.slice(0, -1)} Years`;
  return p.toUpperCase();
}

function loadServices() {
  return db.prepare('SELECT * FROM vpn_api_services ORDER BY name, days, service').all()
    .map(r => ({ ...r, pkg_label: r.pkg_id ? fmtPkg(r.pkg_id) : '—' }));
}

// ---------- pages ----------
router.get('/', async (req, res, next) => {
  try {
    const { url, key } = getApiConf();
    const services = loadServices();
    const lastSync = parseInt(cfgGet('vpnapi_last_sync', '0'), 10) || 0;

    let balance = null, balanceErr = null;
    if (key) {
      try {
        const r = await apiCall('balance');
        if (r && r.status === 'success') balance = `${r.balance} ${r.currency || ''}`.trim();
        else balanceErr = (r && r.message) || 'Unknown error';
      } catch (e) { balanceErr = e.message; }
    }

    res.render('vpnapi', {
      apiUrl: url,
      keySet: !!key,
      keyMask: key ? key.slice(0, 10) + '…' + key.slice(-4) : '',
      services, balance, balanceErr, lastSync,
      msg: req.query.msg || null,
    });
  } catch (e) { next(e); }
});

// Save API URL + Key
router.post('/settings', (req, res) => {
  const url = String(req.body.api_url || '').trim();
  const key = String(req.body.api_key || '').trim();
  if (url) {
    if (!/^https?:\/\/.+/i.test(url)) {
      return res.redirect('/vpnapi?msg=' + encodeURIComponent('❌ API URL ভুল (http/https দিয়ে শুরু হতে হবে)'));
    }
    cfgSet('vpnapi_url', url);
  }
  if (key) cfgSet('vpnapi_key', key);
  logAudit('admin', 'vpnapi_settings', `url=${url ? 'updated' : 'same'} key=${key ? 'updated' : 'same'}`);
  res.redirect('/vpnapi?msg=' + encodeURIComponent('✅ API settings সেভ হয়েছে'));
});

// Sync catalog (brand / package / days / availability) — price unchanged
router.post('/sync', async (req, res) => {
  try {
    const r = await apiCall('services');
    if (!r || r.status !== 'success' || !Array.isArray(r.services)) {
      return res.redirect('/vpnapi?msg=' + encodeURIComponent('❌ Sync fail: ' + ((r && r.message) || 'invalid response')));
    }
    const now = Math.floor(Date.now() / 1000);
    const seen = [];
    const up = db.prepare(`
      INSERT INTO vpn_api_services
        (service,name,category,type,days,pkg_id,vpn_id,rate,original_rate,discount_percent,min_qty,max_qty,available,raw,updated_at)
      VALUES (@service,@name,@category,@type,@days,@pkg_id,@vpn_id,@rate,@original_rate,@discount_percent,@min_qty,@max_qty,@available,@raw,@updated_at)
      ON CONFLICT(service) DO UPDATE SET
        name=excluded.name, category=excluded.category, type=excluded.type,
        days=excluded.days, pkg_id=excluded.pkg_id, vpn_id=excluded.vpn_id,
        rate=excluded.rate, original_rate=excluded.original_rate,
        discount_percent=excluded.discount_percent,
        min_qty=excluded.min_qty, max_qty=excluded.max_qty,
        available=excluded.available, raw=excluded.raw, updated_at=excluded.updated_at
    `);

    const tx = db.transaction((list) => {
      for (const s of list) {
        const dur = parseDuration(`${s.category || ''} ${s.name || ''}`);
        const code = String(s.service || '').trim();
        if (!code) continue;
        seen.push(code);
        up.run({
          service: code,
          name: s.name || code,
          category: s.category || '',
          type: s.type || '',
          days: dur.days,
          pkg_id: dur.pkg_id,
          vpn_id: slugBrand(s.name),
          rate: Number(s.rate) || 0,
          original_rate: Number(s.original_rate) || 0,
          discount_percent: Number(s.discount_percent) || 0,
          min_qty: parseInt(s.min, 10) || 1,
          max_qty: parseInt(s.max, 10) || 1,
          available: (s.available === false || s.available === 0) ? 0 : 1,
          raw: JSON.stringify(s),
          updated_at: now,
        });
      }
      // anything not returned this time = no longer offered
      if (seen.length) {
        const ph = seen.map(() => '?').join(',');
        db.prepare(`UPDATE vpn_api_services SET available=0, updated_at=? WHERE service NOT IN (${ph})`)
          .run(now, ...seen);
      }
    });
    tx(r.services);

    cfgSet('vpnapi_last_sync', now);
    logAudit('admin', 'vpnapi_sync', `${seen.length} services synced`);
    res.redirect('/vpnapi?msg=' + encodeURIComponent(`✅ ${seen.length} টি service sync হলো (price অপরিবর্তিত)`));
  } catch (e) {
    res.redirect('/vpnapi?msg=' + encodeURIComponent('❌ ' + e.message));
  }
});

// Create matching rows in our vpn_packages (brand + package only, price stays 0 / unchanged)
router.post('/import', (req, res) => {
  const rows = db.prepare('SELECT vpn_id, pkg_id FROM vpn_api_services WHERE available=1 AND pkg_id IS NOT NULL').all();
  let added = 0, kept = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const ex = db.prepare('SELECT 1 FROM vpn_packages WHERE vpn_id=? AND pkg_id=?').get(r.vpn_id, r.pkg_id);
      if (ex) { kept++; continue; }
      db.prepare('INSERT INTO vpn_packages (vpn_id, pkg_id, price) VALUES (?, ?, 0)').run(r.vpn_id, r.pkg_id);
      added++;
    }
  });
  tx();
  logAudit('admin', 'vpnapi_import', `added=${added} existing=${kept}`);
  res.redirect('/vpnapi?msg=' + encodeURIComponent(
    `✅ ${added} টি নতুন package যোগ হলো (price 0 — /vpn পেজে price বসান), ${kept} টি আগেই ছিল`
  ));
});

module.exports = router;
