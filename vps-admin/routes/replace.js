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

// GET list of replace requests
router.get('/', (req, res) => {
  const status = req.query.status || 'pending';
  const q = (req.query.q || '').trim();

  let sql = 'SELECT * FROM replace_requests WHERE status = ?';
  const params = [status];
  if (q) {
    sql += ` AND (LOWER(COALESCE(username,'')) LIKE ? OR CAST(user_id AS TEXT) LIKE ?
             OR LOWER(COALESCE(old_data,'')) LIKE ? OR LOWER(COALESCE(replacement_data,'')) LIKE ?
             OR LOWER(COALESCE(category,'')) LIKE ?)`;
    const like = `%${q.toLowerCase()}%`;
    params.push(like, `%${q}%`, like, like, like);
  }
  sql += ' ORDER BY created_at DESC LIMIT 500';

  const rows = db.prepare(sql).all(...params);
  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='pending'").get().c,
    replaced: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='replaced'").get().c,
    collected: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='collected'").get().c,
    rejected: db.prepare("SELECT COUNT(*) AS c FROM replace_requests WHERE status='rejected'").get().c,
  };
  res.render('replace', { rows, status, counts, q, msg: req.query.msg || null });
});

// GET full data by ID (for modal viewer to avoid HTML attribute escaping issues)
router.get('/:id/data', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id, user_id, username, category, old_data, replacement_data, replacement_file, reason, status, created_at, resolved_at FROM replace_requests WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, data: row });
});

// POST Give Replacement (Text or File)
router.post('/:id/resolve', upload.single('replace_file'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM replace_requests WHERE id = ?').get(id);
  if (!row) return res.redirect('/replace?msg=' + encodeURIComponent('❌ Request not found'));

  const replaceText = (req.body.replacement_text || '').trim();
  const file = req.file;

  if (!replaceText && !file) {
    return res.redirect('/replace?msg=' + encodeURIComponent('❌ টেক্সট অথবা ফাইল যেকোনো একটি দিতে হবে!'));
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

module.exports = router;
