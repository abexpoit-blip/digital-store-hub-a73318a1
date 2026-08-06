// VPN Price Manager — add / edit / delete VPN packages & prices from web panel.
// Bot reads prices live from the same store.db, so changes apply instantly in Telegram.
const express = require('express');
const { db, logAudit } = require('../db');
const router = express.Router();

// Ensure table exists (matches bot's vpn_packages usage)
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vpn_packages (
      vpn_id TEXT NOT NULL,
      pkg_id TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (vpn_id, pkg_id)
    );
  `);
} catch (e) { console.warn('[vpn] table init:', e.message); }

function cols() {
  try { return db.prepare('PRAGMA table_info(vpn_packages)').all().map(c => c.name); }
  catch (_) { return []; }
}
const hasCol = (n) => cols().includes(n);

function fmtPkg(pkg_id) {
  if (!pkg_id) return '';
  const p = String(pkg_id).toLowerCase();
  if (/^\d+d$/.test(p)) return `${p.slice(0, -1)} Days`;
  if (/^\d+m$/.test(p)) return `${p.slice(0, -1)} Months`;
  if (/^\d+y$/.test(p)) return `${p.slice(0, -1)} Years`;
  return String(pkg_id).toUpperCase();
}

function brandName(vpn_id) {
  const map = { nord: 'NordVPN', express: 'ExpressVPN', proton: 'ProtonVPN', surfshark: 'Surfshark', hma: 'HideMyAss' };
  return map[String(vpn_id).toLowerCase()] || String(vpn_id).replace(/\b\w/g, c => c.toUpperCase()) + ' VPN';
}

function loadAll() {
  const rows = db.prepare('SELECT vpn_id, pkg_id, price FROM vpn_packages ORDER BY vpn_id, pkg_id').all();
  const groups = {};
  for (const r of rows) {
    const k = String(r.vpn_id).toLowerCase();
    if (!groups[k]) groups[k] = { vpn_id: k, name: brandName(k), items: [] };
    groups[k].items.push({ ...r, pkg_label: fmtPkg(r.pkg_id) });
  }
  return Object.values(groups);
}

router.get('/', (req, res) => {
  const brands = loadAll();
  const svcRow = db.prepare("SELECT value FROM config WHERE key='vpn_service_enabled'").get();
  const svcVal = svcRow ? String(svcRow.value).toLowerCase() : 'on';
  const serviceOn = !['0', 'off', 'false', 'no', 'closed', 'disabled'].includes(svcVal);
  const totalPkgs = brands.reduce((a, b) => a + b.items.length, 0);
  res.render('vpn', {
    brands, serviceOn, totalPkgs,
    msg: req.query.msg || null,
  });
});

// Add or update a package (upsert)
router.post('/save', (req, res) => {
  const vpn_id = String(req.body.vpn_id || '').trim().toLowerCase();
  const pkg_id = String(req.body.pkg_id || '').trim().toLowerCase();
  const price = parseInt(req.body.price, 10);
  const back = '/vpn?msg=';

  if (!/^[a-z0-9_-]{2,20}$/.test(vpn_id)) {
    return res.redirect(back + encodeURIComponent('❌ VPN id ভুল (শুধু a-z, 0-9, -, _ ; 2-20 অক্ষর)'));
  }
  if (!/^[a-z0-9]{1,12}$/.test(pkg_id)) {
    return res.redirect(back + encodeURIComponent('❌ Package id ভুল (যেমন: 7d, 1m, 1y)'));
  }
  if (!Number.isFinite(price) || price < 0 || price > 1000000) {
    return res.redirect(back + encodeURIComponent('❌ Price 0-1000000 হতে হবে'));
  }

  const existing = db.prepare('SELECT price FROM vpn_packages WHERE vpn_id=? AND pkg_id=?').get(vpn_id, pkg_id);
  if (existing) {
    db.prepare('UPDATE vpn_packages SET price=? WHERE vpn_id=? AND pkg_id=?').run(price, vpn_id, pkg_id);
    logAudit('admin', 'vpn_price_update', `${vpn_id}/${pkg_id}: ${existing.price} → ${price}`);
    return res.redirect(back + encodeURIComponent(`✅ Price update: ${brandName(vpn_id)} · ${fmtPkg(pkg_id)} = ${price}৳`));
  }

  const c = cols();
  const extra = {};
  if (c.includes('name')) extra.name = fmtPkg(pkg_id);
  if (c.includes('vpn_name')) extra.vpn_name = brandName(vpn_id);
  if (c.includes('created_at')) extra.created_at = Math.floor(Date.now() / 1000);

  const keys = ['vpn_id', 'pkg_id', 'price', ...Object.keys(extra)];
  const vals = [vpn_id, pkg_id, price, ...Object.values(extra)];
  db.prepare(
    `INSERT INTO vpn_packages (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...vals);
  logAudit('admin', 'vpn_price_add', `${vpn_id}/${pkg_id} = ${price}`);
  res.redirect(back + encodeURIComponent(`✅ নতুন package: ${brandName(vpn_id)} · ${fmtPkg(pkg_id)} = ${price}৳`));
});

// Delete one package
router.post('/delete', (req, res) => {
  const vpn_id = String(req.body.vpn_id || '').trim().toLowerCase();
  const pkg_id = String(req.body.pkg_id || '').trim().toLowerCase();
  const r = db.prepare('DELETE FROM vpn_packages WHERE vpn_id=? AND pkg_id=?').run(vpn_id, pkg_id);
  logAudit('admin', 'vpn_price_delete', `${vpn_id}/${pkg_id} removed=${r.changes}`);
  res.redirect('/vpn?msg=' + encodeURIComponent(r.changes
    ? `🗑️ Deleted: ${brandName(vpn_id)} · ${fmtPkg(pkg_id)}`
    : '❌ Package পাওয়া যায়নি'));
});

// Delete a whole brand (all its packages)
router.post('/delete-brand', (req, res) => {
  const vpn_id = String(req.body.vpn_id || '').trim().toLowerCase();
  const r = db.prepare('DELETE FROM vpn_packages WHERE vpn_id=?').run(vpn_id);
  logAudit('admin', 'vpn_brand_delete', `${vpn_id} packages=${r.changes}`);
  res.redirect('/vpn?msg=' + encodeURIComponent(`🗑️ ${brandName(vpn_id)} এর ${r.changes} package delete হলো`));
});

// Global VPN service ON/OFF (same config key the bot checks)
router.post('/toggle', (req, res) => {
  const next = req.body.state === 'off' ? 'off' : 'on';
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('vpn_service_enabled', ?)").run(next);
  logAudit('admin', 'vpn_service_toggle', next);
  res.redirect('/vpn?msg=' + encodeURIComponent(next === 'on'
    ? '✅ VPN সার্ভিস চালু হলো'
    : '⛔ VPN সার্ভিস বন্ধ — user রা "unavailable" message পাবে'));
});

module.exports = router;
