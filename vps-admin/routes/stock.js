const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, logAudit, cleanupOldUidHistory } = require('../db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ALLOWED_CATEGORIES = ['fb61', 'fb1000', 'fb1000_used', 'tempid'];
const SEPARATOR = '###';
const HISTORY_DAYS = 3;

function extractUid(line) {
  if (!line) return '';
  return String(line).trim().split(/\s+/)[0] || '';
}

function findHistoryMatches(uids) {
  if (!uids.length) return new Map();
  cleanupOldUidHistory(HISTORY_DAYS);
  const placeholders = uids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT uid, category, first_uploaded_at, upload_count FROM uid_history WHERE uid IN (${placeholders})`
  ).all(...uids);
  return new Map(rows.map(r => [r.uid, r]));
}

function recordUidHistory(items) {
  const now = Date.now();
  const up = db.prepare(`
    INSERT INTO uid_history (uid, category, first_uploaded_at, last_seen_at, upload_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(uid) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      upload_count = uid_history.upload_count + 1
  `);
  const tx = db.transaction((arr) => {
    for (const it of arr) {
      const uid = extractUid(it.data || it);
      if (uid) up.run(uid, it.category || null, now, now);
    }
  });
  tx(items);
}


function getCategoryStats() {
  return db.prepare('SELECT category, COUNT(*) AS c FROM stock GROUP BY category ORDER BY category ASC').all();
}

function renderPage(extra = {}) {
  const byCategory = getCategoryStats();
  const recent = db.prepare('SELECT id, category, substr(data,1,80) AS preview FROM stock ORDER BY id DESC LIMIT 50').all();
  // Show ALL allowed categories even if 0 count, so admin sees full list
  const statsMap = Object.fromEntries(byCategory.map(c => [c.category, c.c]));
  const fullCategoryList = ALLOWED_CATEGORIES.map(cat => ({ category: cat, c: statsMap[cat] || 0 }));
  // Append any unknown categories already in DB (so admin sees them)
  byCategory.forEach(c => {
    if (!ALLOWED_CATEGORIES.includes(c.category)) fullCategoryList.push({ category: c.category, c: c.c, unknown: true });
  });
  return {
    byCategory: fullCategoryList,
    allowedCategories: ALLOWED_CATEGORIES,
    recent,
    preview: null,
    previewCount: 0,
    previewByCat: {},
    msg: null,
    ...extra,
  };
}

// Parse stock items from raw text input.
// Supports:
//   1) Multiple items on separate lines
//   2) Multiple items separated by ###
//   3) Each item: "UID PASS COOKIES" (space-separated, COOKIES can contain spaces — only first 2 spaces split)
function parseStockItems(rawText) {
  if (!rawText) return [];
  // Split by newlines AND ### separator
  const chunks = rawText
    .split(/\r?\n|###/)
    .map(s => s.trim())
    .filter(Boolean);
  return chunks;
}

// Parse Excel — supports either:
//   A) Single column = full "UID PASS COOKIES" string per row
//   B) 3 columns = UID | PASS | COOKIES (auto-joined with space, exactly like /add command)
function parseExcelRow(row) {
  // row is array of cells
  const nonEmpty = row.map(c => (c ?? '').toString().trim()).filter(Boolean);
  if (!nonEmpty.length) return null;
  if (nonEmpty.length === 1) return nonEmpty[0]; // already-formatted single cell
  if (nonEmpty.length >= 3) {
    // UID PASS COOKIES — join all with space (cookies may have multiple parts)
    return nonEmpty.join(' ');
  }
  // 2 cells — likely incomplete, skip
  return null;
}

router.get('/', (req, res) => {
  res.render('stock', renderPage({ msg: req.query.msg || null }));
});

// Excel upload → preview
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.redirect('/stock?msg=No+file');

  const targetCategory = (req.body.category || '').trim();
  if (!ALLOWED_CATEGORIES.includes(targetCategory)) {
    return res.redirect('/stock?msg=' + encodeURIComponent(
      `❌ Invalid category. শুধু এগুলো allowed: ${ALLOWED_CATEGORIES.join(', ')}`
    ));
  }

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.redirect('/stock?msg=' + encodeURIComponent('❌ Invalid Excel file: ' + e.message));
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Skip header row if first cell looks like a label
  const headerRe = /^(uid|pass|password|cookies?|data|id|category)$/i;
  let startIdx = 0;
  if (rows.length && rows[0].some(c => c && headerRe.test(String(c).trim()))) startIdx = 1;

  const items = [];
  for (let i = startIdx; i < rows.length; i++) {
    const dataStr = parseExcelRow(rows[i]);
    if (dataStr) items.push({ category: targetCategory, data: dataStr });
  }

  if (!items.length) {
    return res.redirect('/stock?msg=' + encodeURIComponent('❌ Excel এ valid row পাওয়া যায়নি'));
  }

  // Duplicate detection (current stock)
  const existSet = new Set(db.prepare('SELECT data FROM stock').all().map(r => r.data));
  let duplicates = 0;
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    if (existSet.has(it.data) || seen.has(it.data)) { duplicates++; continue; }
    seen.add(it.data);
    unique.push(it);
  }

  // History check — UID আগে কখনো upload হয়েছিল কিনা (last 3 days)
  const uids = unique.map(u => extractUid(u.data)).filter(Boolean);
  const histMap = findHistoryMatches(uids);
  unique.forEach(u => {
    const uid = extractUid(u.data);
    const h = histMap.get(uid);
    if (h) {
      u.previouslyUploaded = true;
      u.firstUploadedAt = h.first_uploaded_at;
      u.uploadCount = h.upload_count;
    }
  });
  const historyMatches = unique.filter(u => u.previouslyUploaded).length;

  const previewByCat = { [targetCategory]: unique.length };
  req.session.pendingStock = unique;

  const msgParts = [];
  if (duplicates) msgParts.push(`ℹ️ ${duplicates} duplicate (stock-এ already আছে) skip`);
  if (historyMatches) msgParts.push(`⚠️ ${historyMatches} UID আগে upload হয়েছিল (preview-তে badge দেখুন)`);

  res.render('stock', renderPage({
    preview: unique.slice(0, 200),
    previewCount: unique.length,
    previewByCat,
    duplicates,
    historyMatches,
    msg: msgParts.join(' • ') || null,
  }));
});

router.post('/confirm', (req, res) => {
  const pending = req.session.pendingStock || [];
  if (!pending.length) return res.redirect('/stock?msg=Nothing+to+confirm');

  const insert = db.prepare('INSERT INTO stock (category, data) VALUES (?, ?)');
  const tx = db.transaction((items) => { for (const it of items) insert.run(it.category, it.data); });
  tx(pending);

  // Record UID history
  try { recordUidHistory(pending); } catch (e) { console.warn('uid_history record failed:', e.message); }

  const breakdown = {};
  pending.forEach(p => { breakdown[p.category] = (breakdown[p.category] || 0) + 1; });
  const summary = Object.entries(breakdown).map(([k, v]) => `${k}:${v}`).join(', ');

  logAudit('admin', 'stock_upload', `total=${pending.length} (${summary})`);
  req.session.pendingStock = null;
  res.redirect('/stock?msg=' + encodeURIComponent(`✅ ${pending.length} items added (${summary})`));
});

router.post('/cancel', (req, res) => {
  req.session.pendingStock = null;
  res.redirect('/stock?msg=Upload+cancelled');
});

// Manual textarea — supports newline OR ### separator, exactly like bot
router.post('/manual', (req, res) => {
  const category = (req.body.category || '').trim();
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return res.redirect('/stock?msg=' + encodeURIComponent(
      `❌ Invalid category. শুধু এগুলো allowed: ${ALLOWED_CATEGORIES.join(', ')}`
    ));
  }

  const items = parseStockItems(req.body.data || '');
  if (!items.length) {
    return res.redirect('/stock?msg=' + encodeURIComponent('❌ Data খালি'));
  }

  const existSet = new Set(db.prepare('SELECT data FROM stock').all().map(r => r.data));
  const unique = [];
  const seen = new Set();
  let duplicates = 0;
  for (const d of items) {
    if (existSet.has(d) || seen.has(d)) { duplicates++; continue; }
    seen.add(d);
    unique.push(d);
  }

  if (!unique.length) {
    return res.redirect('/stock?msg=' + encodeURIComponent(`❌ সব ${items.length} item আগে থেকেই আছে`));
  }

  const insert = db.prepare('INSERT INTO stock (category, data) VALUES (?, ?)');
  const tx = db.transaction((arr) => { for (const d of arr) insert.run(category, d); });
  tx(unique);

  // History check + record
  const uids = unique.map(extractUid).filter(Boolean);
  const histMap = findHistoryMatches(uids);
  const historyMatches = uids.filter(u => histMap.has(u)).length;
  try { recordUidHistory(unique.map(d => ({ category, data: d }))); } catch (e) {}

  logAudit('admin', 'stock_manual', `category=${category} added=${unique.length} dup=${duplicates} hist=${historyMatches}`);
  const parts = [`✅ ${unique.length} items added to ${category}`];
  if (duplicates) parts.push(`${duplicates} duplicate skipped`);
  if (historyMatches) parts.push(`⚠️ ${historyMatches} UID আগে upload হয়েছিল`);
  res.redirect('/stock?msg=' + encodeURIComponent(parts.join(' • ')));
});

// ===== UID CHECKER =====
// Paste UIDs (one per line or space-separated) → check which were uploaded before
router.get('/check-uid', (req, res) => {
  cleanupOldUidHistory(HISTORY_DAYS);
  const total = db.prepare('SELECT COUNT(*) AS c FROM uid_history').get().c;
  res.render('check-uid', { results: null, input: '', total, days: HISTORY_DAYS, msg: null, currentPath: '/stock/check-uid' });
});

router.post('/check-uid', (req, res) => {
  cleanupOldUidHistory(HISTORY_DAYS);
  const input = (req.body.uids || '').trim();
  const uids = [...new Set(input.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];

  const histMap = findHistoryMatches(uids);
  const results = uids.map(uid => {
    const h = histMap.get(uid);
    return {
      uid,
      found: !!h,
      category: h ? h.category : null,
      firstUploadedAt: h ? h.first_uploaded_at : null,
      uploadCount: h ? h.upload_count : 0,
    };
  });

  const total = db.prepare('SELECT COUNT(*) AS c FROM uid_history').get().c;
  const foundCount = results.filter(r => r.found).length;
  res.render('check-uid', {
    results,
    input,
    total,
    days: HISTORY_DAYS,
    msg: `Checked ${uids.length} UID • ${foundCount} আগে upload হয়েছিল • ${uids.length - foundCount} নতুন`,
    currentPath: '/stock/check-uid',
  });
});

router.post('/clear/:category', (req, res) => {
  const cat = req.params.category;
  const result = db.prepare('DELETE FROM stock WHERE category = ?').run(cat);
  logAudit('admin', 'stock_clear', `category=${cat} deleted=${result.changes}`);
  res.redirect('/stock?msg=' + encodeURIComponent(`Cleared ${result.changes} from ${cat}`));
});

// ===== QUICK SELL / DELIVER =====
// Admin selects category + qty → system pulls N items, deletes from stock,
// logs sale, and returns Excel file containing those N IDs (UID/PASS/COOKIES).
router.post('/sell', (req, res) => {
  const category = (req.body.category || '').trim();
  const qty = Math.max(1, parseInt(req.body.qty, 10) || 0);
  const buyer = (req.body.buyer || '').trim() || 'manual-admin';
  const price = parseFloat(req.body.price) || 0;

  if (!ALLOWED_CATEGORIES.includes(category)) {
    return res.redirect('/stock?msg=' + encodeURIComponent(
      `❌ Invalid category. Allowed: ${ALLOWED_CATEGORIES.join(', ')}`
    ));
  }

  // Pull N rows + delete in one transaction (race-safe)
  let rows;
  try {
    rows = db.transaction(() => {
      const picked = db.prepare(
        'SELECT id, data FROM stock WHERE category = ? ORDER BY id ASC LIMIT ?'
      ).all(category, qty);
      if (picked.length < qty) {
        const e = new Error(`Insufficient stock — ${category} এ মাত্র ${picked.length} টা আছে, চাওয়া হয়েছে ${qty}`);
        e.code = 'NO_STOCK';
        throw e;
      }
      const del = db.prepare('DELETE FROM stock WHERE id = ?');
      for (const r of picked) del.run(r.id);
      return picked;
    })();
  } catch (e) {
    return res.redirect('/stock?msg=' + encodeURIComponent('❌ ' + e.message));
  }

  // Log to sales table + archive each delivered item. Best-effort — don't fail download if schema differs.
  let saleId = null;
  try {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 8);
    const info = db.prepare(
      `INSERT INTO sales (user_id, username, category, qty, total, date, time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(0, buyer, category, rows.length, price * rows.length, date, time);
    saleId = info.lastInsertRowid;
  } catch (e) { /* schema mismatch — skip */ }

  // Archive delivered items so admin can see exactly what each user received
  try {
    const archive = db.prepare(
      `INSERT INTO delivery_archive (sale_id, user_id, username, category, stock_id, data, source, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)`
    );
    const ts = Date.now();
    const tx = db.transaction((items) => {
      for (const r of items) archive.run(saleId, 0, buyer, category, r.id, r.data, ts);
    });
    tx(rows);
  } catch (e) { /* table missing on first run */ }

  logAudit('admin', 'stock_sell', `category=${category} qty=${rows.length} buyer=${buyer}`);

  // Build Excel — split each "UID PASS COOKIES" back into 3 columns
  const header = ['#', 'UID', 'PASS', 'COOKIES'];
  const data = [header];
  rows.forEach((r, i) => {
    const parts = (r.data || '').split(/\s+/);
    const uid = parts[0] || '';
    const pass = parts[1] || '';
    const cookies = parts.slice(2).join(' ');
    data.push([i + 1, uid, pass, cookies]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 4 }, { wch: 20 }, { wch: 18 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws, category);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition',
    `attachment; filename="${category}-${rows.length}items-${buyer}-${stamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Sample Excel template — 3-column UID/PASS/COOKIES format that matches /add command
router.get('/sample', (req, res) => {
  const wb = XLSX.utils.book_new();
  const data = [
    ['UID', 'PASS', 'COOKIES'],
    ['100011382171459', 'Sabbir@25', 'datr=ODPsaTn3HNRjTmauBgaPNa_-; sb=ODPsaUcA8mIaOd096mx8BtLS; c_user=100011382171459; xs=33%3A88s2rhCWKRnhLA%3A2'],
    ['100011382171460', 'Example@99', 'datr=ABC123; sb=XYZ789; c_user=100011382171460; xs=44%3Aexample'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 20 }, { wch: 15 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=stock-sample.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
