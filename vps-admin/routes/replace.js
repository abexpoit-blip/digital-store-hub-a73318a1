const express = require('express');
const multer = require('multer');
const { db, logAudit } = require('../db');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';

// Telegram text notify
async function notifyUser(userId, text) {
  if (!BOT_TOKEN || !userId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: userId, text, parse_mode: 'Markdown' }),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: userId, text }),
      });
    }
  } catch (e) {
    console.error('[replace] notify failed:', e.message);
  }
}

// Telegram document send (file replacement)
async function sendDocumentToUser(userId, buffer, filename, caption = '') {
  if (!BOT_TOKEN || !userId || !buffer) return false;
  try {
    const formData = new FormData();
    formData.append('chat_id', String(userId));
    formData.append('caption', caption);
    formData.append('document', new Blob([buffer]), filename || 'replacement.txt');

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    return data && data.ok;
  } catch (e) {
    console.error('[replace] sendDocument failed:', e.message);
    return false;
  }
}

function extractUidsFromText(text) {
  if (!text) return [];
  const found = new Set();
  const re = /\b(1000\d{7,13}|615\d{7,13}|61\d{8,13}|\d{10,18})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1]);
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[\s:,|]+/);
    const firstToken = (parts[0] || '').replace(/[`*#]/g, '');
    if (/^\d{9,18}$/.test(firstToken)) {
      found.add(firstToken);
    }
  }
  return Array.from(found);
}

function findSellersForUids(uids) {
  if (!uids || !uids.length) return new Map();
  const sellerMap = new Map();
  
  // 1. Check uid_history
  const placeholders = uids.map(() => '?').join(',');
  try {
    const histRows = db.prepare(
      `SELECT uid, seller_name FROM uid_history WHERE uid IN (${placeholders}) AND seller_name IS NOT NULL AND seller_name != ''`
    ).all(...uids);
    for (const r of histRows) {
      if (r.seller_name) sellerMap.set(r.uid, r.seller_name);
    }
  } catch (_) {}

  // 2. Check delivery_archive for missing ones
  const missingFromHist = uids.filter(u => !sellerMap.has(u));
  if (missingFromHist.length) {
    try {
      const delivStmt = db.prepare(
        `SELECT seller_name FROM delivery_archive WHERE data LIKE ? AND seller_name IS NOT NULL AND seller_name != '' ORDER BY id DESC LIMIT 1`
      );
      for (const uid of missingFromHist) {
        const row = delivStmt.get(`%${uid}%`);
        if (row && row.seller_name) sellerMap.set(uid, row.seller_name);
      }
    } catch (_) {}
  }

  // 3. Check stock for any still missing
  const stillMissing = uids.filter(u => !sellerMap.has(u));
  if (stillMissing.length) {
    try {
      const stockStmt = db.prepare(
        `SELECT seller_name FROM stock WHERE data LIKE ? AND seller_name IS NOT NULL AND seller_name != '' ORDER BY id DESC LIMIT 1`
      );
      for (const uid of stillMissing) {
        const row = stockStmt.get(`%${uid}%`);
        if (row && row.seller_name) sellerMap.set(uid, row.seller_name);
      }
    } catch (_) {}
  }

  return sellerMap;
}

// GET list of replace requests
router.get('/', (req, res) => {
  const status = req.query.status || 'pending';
  const q = (req.query.q || '').trim();
  const cat = (req.query.cat || 'all').trim();

  let sql = 'SELECT * FROM replace_requests WHERE status = ?';
  const params = [status];
  if (cat === 'used') {
    sql += " AND (LOWER(category) LIKE '%used%')";
  } else if (cat === 'fresh') {
    sql += " AND (LOWER(category) NOT LIKE '%used%')";
  }
  if (q) {
    sql += ` AND (LOWER(COALESCE(username,'')) LIKE ? OR CAST(user_id AS TEXT) LIKE ?
             OR LOWER(COALESCE(old_data,'')) LIKE ? OR LOWER(COALESCE(replacement_data,'')) LIKE ?
             OR LOWER(COALESCE(category,'')) LIKE ?)`;
    const like = `%${q.toLowerCase()}%`;
    params.push(like, `%${q}%`, like, like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT 500';

  const rows = db.prepare(sql).all(...params);

  // Extract UIDs and find sellers for visible rows
  const allRowUids = [];
  rows.forEach(r => {
    r.detectedUids = extractUidsFromText(r.old_data);
    allRowUids.push(...r.detectedUids);
  });
  const rowSellerMap = findSellersForUids(allRowUids);
  rows.forEach(r => {
    const foundSellers = Array.from(new Set(r.detectedUids.map(u => rowSellerMap.get(u)).filter(Boolean)));
    r.sellers = foundSellers.length ? foundSellers : (r.seller_name ? [r.seller_name] : []);
    r.primarySeller = r.sellers[0] || r.seller_name || null;
  });

  // Build aggregate Seller-wise Replace Report from persistent collector
  try {
    const totalCollected = db.prepare("SELECT COUNT(*) AS c FROM seller_uid_collector").get().c;
    if (totalCollected === 0) {
      // Auto-backfill from replace_requests so historical claims appear
      const oldReqs = db.prepare("SELECT id, user_id, category, old_data, seller_name, created_at, detected_uids FROM replace_requests").all();
      const insertSuc = db.prepare(`
        INSERT INTO seller_uid_collector (seller_name, uid, category, user_id, request_id, submitted_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
      `);
      oldReqs.forEach(req => {
        let uids = [];
        if (req.detected_uids) {
          uids = req.detected_uids.split(',').map(u => u.trim()).filter(Boolean);
        } else if (req.old_data) {
          uids = extractUidsFromText(req.old_data);
        }
        const sMap = findSellersForUids(uids);
        const subAt = req.created_at && req.created_at > 100000000000 ? Math.floor(req.created_at / 1000) : (req.created_at || Math.floor(Date.now() / 1000));
        uids.forEach(u => {
          const s = sMap.get(u) || req.seller_name || 'Unassigned';
          try {
            insertSuc.run(s, u, req.category, req.user_id, req.id, subAt);
          } catch (_) {}
        });
      });
    }
  } catch (_) {}

  const activeCollectorRows = db.prepare(`
    SELECT seller_name, uid, request_id 
    FROM seller_uid_collector 
    WHERE status = 'active'
    ORDER BY id DESC
  `).all();

  const sellerGroups = {};
  activeCollectorRows.forEach(row => {
    const sName = row.seller_name || 'Unassigned (সেলার ছাড়া)';
    if (!sellerGroups[sName]) {
      sellerGroups[sName] = { seller: sName, uids: [], requestIds: new Set() };
    }
    if (!sellerGroups[sName].uids.includes(row.uid)) {
      sellerGroups[sName].uids.push(row.uid);
    }
    if (row.request_id) sellerGroups[sName].requestIds.add(row.request_id);
  });

  const sellerReports = Object.values(sellerGroups).map(g => ({
    seller: g.seller,
    count: g.uids.length,
    uids: g.uids,
    uidsText: g.uids.join('\n'),
    requestCount: g.requestIds.size,
  })).sort((a, b) => b.count - a.count);

  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='pending'").get().c,
    replaced: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='replaced'").get().c,
    collected: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='collected'").get().c,
    rejected: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='rejected'").get().c,
    usedPending: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='pending' AND LOWER(category) LIKE '%used%'").get().c,
  };
  const stockCounts = {
    fb1000_used: db.prepare("SELECT COUNT(*) AS c FROM stock WHERE category='fb1000_used'").get().c,
    fb1000: db.prepare("SELECT COUNT(*) AS c FROM stock WHERE category='fb1000'").get().c,
    fb61: db.prepare("SELECT COUNT(*) AS c FROM stock WHERE category='fb61'").get().c,
  };
  res.render('replace', { rows, status, counts, q, cat, stockCounts, sellerReports, msg: req.query.msg || null });
});

// GET full data by ID (for modal viewer to avoid HTML attribute escaping issues)
router.get('/:id/data', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id, user_id, username, category, old_data, replacement_data, replacement_file, reason, status, created_at, resolved_at FROM replace_requests WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: row });
});

// POST Give Replacement (Text, File, or Stock Auto-Fetch)
router.post('/:id/resolve', upload.single('replace_file'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM replace_requests WHERE id = ?').get(id);
  if (!row) return res.redirect('/replace?msg=' + encodeURIComponent('❌ Request not found'));

  let replaceText = (req.body.replacement_text || '').trim();
  const file = req.file;
  const useStock = req.body.use_stock === '1';
  const stockCat = (req.body.stock_category || '').trim();

  // If Admin selected "Auto-fetch from Stock"
  if (useStock && stockCat) {
    const qty = Math.max(1, parseInt(req.body.stock_qty, 10) || 1);
    const stockItems = db.prepare('SELECT id, data FROM stock WHERE category = ? LIMIT ?').all(stockCat, qty);
    if (stockItems.length < qty) {
      return res.redirect('/replace?msg=' + encodeURIComponent(`❌ পর্যাপ্ত স্টক নেই! '${stockCat}' এ আছে ${stockItems.length}টি`));
    }
    const lines = [];
    const delIds = [];
    for (const item of stockItems) {
      delIds.push(item.id);
      let raw = item.data;
      if (raw.includes('UID:') || raw.includes('🆔')) {
        const mUid = raw.match(/(?:UID|Temp ID|FB ID):\*?\*?\s*`?([^\s`\n]+)`?/i);
        const mPass = raw.match(/(?:PASS):\*?\*?\s*`?([^\s`\n]+)`?/i);
        const mCookie = raw.match(/(?:COOKIE):\*?\*?\s*`?([^\n`]+)`?/i);
        if (mUid && mPass) {
          raw = `${mUid[1]} ${mPass[1]} ${mCookie ? mCookie[1].trim() : ''}`;
        }
      }
      lines.push(raw.trim());
    }
    replaceText = lines.join('\n');
    const placeholders = delIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM stock WHERE id IN (${placeholders})`).run(...delIds);
  }

  if (!replaceText && !file) {
    return res.redirect('/replace?msg=' + encodeURIComponent('❌ টেক্সট, ফাইল অথবা স্টক যেকোনো একটি থেকে রিপ্লেস দিতে হবে!'));
  }

  const now = Date.now();

  // 1. If file uploaded, send document to user in Telegram
  if (file) {
    const caption =
      `✅ *আপনার রিপ্লেসমেন্ট ফাইল প্রদান করা হয়েছে!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎫 Request ID: #${row.id}\n` +
      (replaceText ? `📝 Note:\n${replaceText}\n\n` : '') +
      `ফাইলটি ডাউনলোড করে আপনার রিপ্লেস অ্যাকাউন্ট সংগ্রহ করুন। ধন্যবাদ 🙏`;

    await sendDocumentToUser(row.user_id, file.buffer, file.originalname, caption);
  }

  // 2. If only text provided (no file), send text message
  if (!file && replaceText) {
    const userMsg =
      `✅ *আপনার রিপ্লেসমেন্ট প্রদান করা হয়েছে!*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🎫 Request ID: #${row.id}\n\n` +
      `\`\`\`text\n${replaceText}\n\`\`\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💡 *(কপি করতে বক্সের উপর ট্যাপ করুন)*`;

    await notifyUser(row.user_id, userMsg);
  }

  // 3. Update database record
  db.prepare(`
    UPDATE replace_requests
    SET status = 'replaced',
        replacement_data = ?,
        replacement_file = ?,
        resolved_by = 'web-admin',
        resolved_at = ?
    WHERE id = ?
  `).run(
    replaceText || (file ? `[File: ${file.originalname}]` : null),
    file ? file.originalname : null,
    now,
    id
  );

  // 4. Sync support_tickets table if corresponding ticket exists
  try {
    db.prepare(`
      UPDATE support_tickets
      SET status = 'processed', admin_response = ?
      WHERE user_id = ? AND type = 'replace' AND status = 'pending'
    `).run(replaceText || `[File: ${file ? file.originalname : 'sent'}]`, row.user_id);
  } catch (_) {}

  logAudit('admin', 'replace_resolved', `id=${id} user=${row.user_id} file=${file ? file.originalname : 'none'}`);

  res.redirect('/replace?status=replaced&msg=' + encodeURIComponent(`✅ Replacement sent to User ${row.user_id} #${id}`));
});

// POST Collect
router.post('/:id/collect', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM replace_requests WHERE id = ?').get(id);
  db.prepare("UPDATE replace_requests SET status='collected', collected_at=? WHERE id=?")
    .run(Date.now(), id);
  logAudit('admin', 'replace_collected', `id=${id}`);
  if (row && row.user_id) {
    const msg =
      `✅ *Replace Request Accepted*\n\n` +
      `Request ID: #${row.id}\n` +
      `আপনার রিপ্লেস রিকোয়েস্টটি অ্যাডমিন গ্রহণ করেছেন। খুব শীঘ্রই আপনার সাথে যোগাযোগ করে সমাধান দেওয়া হবে।`;
    notifyUser(row.user_id, msg);
  }
  res.redirect('/replace?msg=' + encodeURIComponent('✅ Marked collected & user notified'));
});

// POST Reject — mark rejected + auto-notify user
router.post('/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM replace_requests WHERE id = ?').get(id);
  if (!row) return res.redirect('/replace?msg=' + encodeURIComponent('❌ Not found'));

  const rejectReason = (req.body.reject_reason || '').trim();

  db.prepare("UPDATE replace_requests SET status='rejected', collected_at=? WHERE id=?")
    .run(Date.now(), id);
  logAudit('admin', 'replace_rejected', `id=${id} user=${row.user_id}`);

  // Sync support_tickets
  try {
    db.prepare(`
      UPDATE support_tickets SET status = 'ignored'
      WHERE user_id = ? AND type = 'replace' AND status = 'pending'
    `).run(row.user_id);
  } catch (_) {}

  const reasonText = rejectReason ? `\n\n📌 *কারণ:* ${rejectReason}` : '';
  const msg =
    `❌ *Replace Request Rejected*\n\n` +
    `Category: \`${row.category || '-'}\`\n` +
    `Request ID: #${row.id}${reasonText}\n\n` +
    `⚠️ *নিয়মাবলী:*\n` +
    `• আইডি কেনার নির্ধারিত সময়ের মধ্যে সমস্যা হলে রিপ্লেস দেওয়া হয়।\n` +
    `• আপনার রিকোয়েস্টটি নিয়ম অনুযায়ী গ্রহণযোগ্য নয় বিধায় বাতিল করা হয়েছে।`;
  notifyUser(row.user_id, msg);

  res.redirect('/replace?msg=' + encodeURIComponent('🚫 Rejected & user notified'));
});

// POST Delete
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM replace_requests WHERE id = ?').run(id);
  logAudit('admin', 'replace_delete', `id=${id}`);
  res.redirect('/replace?msg=' + encodeURIComponent('🗑️ Deleted'));
});

// Bulk: delete selected IDs
router.post('/bulk/delete-selected', (req, res) => {
  let ids = req.body.selected_ids;
  if (!ids) {
    return res.redirect('/replace?msg=' + encodeURIComponent('⚠️ কোনো রিকোয়েস্ট সিলেক্ট করা হয়নি!'));
  }
  if (!Array.isArray(ids)) {
    ids = [ids];
  }
  const cleanIds = ids.map((id) => parseInt(id, 10)).filter((n) => !isNaN(n) && n > 0);
  if (!cleanIds.length) {
    return res.redirect('/replace?msg=' + encodeURIComponent('⚠️ সঠিক কোনো রিকোয়েস্ট সিলেক্ট করা হয়নি!'));
  }

  const placeholders = cleanIds.map(() => '?').join(',');
  const r = db.prepare(`DELETE FROM replace_requests WHERE id IN (${placeholders})`).run(...cleanIds);
  logAudit('admin', 'replace_bulk_delete_selected', `count=${r.changes} ids=${cleanIds.join(',')}`);

  res.redirect('/replace?msg=' + encodeURIComponent(`🗑️ ${r.changes} টি সিলেক্টেড রিপ্লেস রিকোয়েস্ট সফলভাবে ডিলিট করা হয়েছে!`));
});

// Bulk: delete all in current status (or all old pending)
router.post('/bulk/clear-all', (req, res) => {
  const status = req.body.status || 'pending';
  const r = db.prepare('DELETE FROM replace_requests WHERE status = ?').run(status);
  logAudit('admin', 'replace_bulk_clear_all', `status=${status} count=${r.changes}`);
  res.redirect(`/replace?status=${status}&msg=` + encodeURIComponent(`🗑️ ${status} স্ট্যাটাসের সব (${r.changes} টি) রিকোয়েস্ট ডিলিট করা হয়েছে!`));
});

// Bulk: delete all collected
router.post('/bulk/delete-collected', (req, res) => {
  const r = db.prepare("DELETE FROM replace_requests WHERE status='collected'").run();
  logAudit('admin', 'replace_bulk_delete_collected', `count=${r.changes}`);
  res.redirect('/replace?status=collected&msg=' +
    encodeURIComponent(`🗑️ ${r.changes} collected entries deleted`));
});

// Bulk: dedupe pending
router.post('/bulk/dedupe', (req, res) => {
  const r = db.prepare(`
    DELETE FROM replace_requests
    WHERE status='pending' AND id NOT IN (
      SELECT MIN(id) FROM replace_requests
      WHERE status='pending'
      GROUP BY user_id, COALESCE(category,''), COALESCE(old_data,'')
    )
  `).run();
  logAudit('admin', 'replace_dedupe', `removed=${r.changes}`);
  res.redirect('/replace?msg=' + encodeURIComponent(`🧹 ${r.changes} duplicate entries removed`));
});

// Seller UID Collector: Clear specific seller UIDs
router.post('/seller-uids/clear', (req, res) => {
  const sellerName = (req.body.seller_name || '').trim();
  if (!sellerName) {
    return res.redirect('/replace?msg=' + encodeURIComponent('❌ Invalid seller name'));
  }
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare("UPDATE seller_uid_collector SET status = 'cleared', cleared_at = ? WHERE seller_name = ? AND status = 'active'").run(now, sellerName);
  logAudit(req.session && req.session.adminUser ? req.session.adminUser : 'admin', 'seller_uids_cleared', `Cleared ${result.changes} UIDs for seller: ${sellerName}`);
  res.redirect('/replace?msg=' + encodeURIComponent(`✅ Seller "${sellerName}"-এর ${result.changes}টি UID সফলভাবে ক্লিয়ার করা হয়েছে!`));
});

// Seller UID Collector: Clear all active seller UIDs
router.post('/seller-uids/clear-all', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare("UPDATE seller_uid_collector SET status = 'cleared', cleared_at = ? WHERE status = 'active'").run(now);
  logAudit(req.session && req.session.adminUser ? req.session.adminUser : 'admin', 'seller_uids_cleared_all', `Cleared all ${result.changes} active UIDs`);
  res.redirect('/replace?msg=' + encodeURIComponent(`✅ সকল সেলারের ${result.changes}টি UID সফলভাবে ক্লিয়ার করা হয়েছে!`));
});

module.exports = router;
