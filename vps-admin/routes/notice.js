// Admin → send Telegram notice (broadcast to all users, or single user).
// Uses bot's Telegram Bot API directly with photo support.
const express = require('express');
const multer = require('multer');
const { db, logAudit } = require('../db');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';

async function tgSendMessage(chatId, text) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  let r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  let j = await r.json().catch(() => ({}));
  if (!j.ok) {
    // Retry without HTML parse_mode in case of invalid HTML tags
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    j = await r.json().catch(() => ({}));
  }
  return { ok: !!j.ok, desc: j.description || '' };
}

async function tgSendPhotoBuffer(chatId, buffer, filename, caption = '') {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer]), filename || 'notice.jpg');
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }

  let r = await fetch(url, { method: 'POST', body: form });
  let j = await r.json().catch(() => ({}));
  if (!j.ok && caption) {
    // Retry without parse_mode
    const fallbackForm = new FormData();
    fallbackForm.append('chat_id', String(chatId));
    fallbackForm.append('photo', new Blob([buffer]), filename || 'notice.jpg');
    fallbackForm.append('caption', caption);
    r = await fetch(url, { method: 'POST', body: fallbackForm });
    j = await r.json().catch(() => ({}));
  }

  let fileId = null;
  if (j.ok && j.result && Array.isArray(j.result.photo) && j.result.photo.length > 0) {
    fileId = j.result.photo[j.result.photo.length - 1].file_id;
  }
  return { ok: !!j.ok, fileId, desc: j.description || '' };
}

async function tgSendPhotoIdOrUrl(chatId, photoIdOrUrl, caption = '') {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const payload = { chat_id: chatId, photo: photoIdOrUrl };
  if (caption) {
    payload.caption = caption;
    payload.parse_mode = 'HTML';
  }

  let r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let j = await r.json().catch(() => ({}));
  if (!j.ok && caption) {
    // Retry without parse_mode
    delete payload.parse_mode;
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    j = await r.json().catch(() => ({}));
  }
  return { ok: !!j.ok, desc: j.description || '' };
}

async function runAsyncBroadcast({ recipients, text, file, imageUrl, adminName }) {
  const hasPhoto = !!(file || imageUrl);
  let cachedPhotoId = imageUrl || null;
  const isCaptionShort = text.length <= 1024;
  const photoCaption = isCaptionShort ? text : '';

  // If file buffer is present, upload once to get fileId
  if (file && !cachedPhotoId && recipients.length > 0) {
    try {
      const r = await tgSendPhotoBuffer(recipients[0], file.buffer, file.originalname, photoCaption);
      if (r && r.fileId) cachedPhotoId = r.fileId;
    } catch (_) {}
  }

  let sent = 0, failed = 0;
  const blockedUids = [];
  const concurrency = 15;
  const delayMs = 40; // ~25 req/sec

  let idx = 0;
  async function worker() {
    while (idx < recipients.length) {
      const myIdx = idx++;
      const uid = recipients[myIdx];
      try {
        let ok = false;
        if (hasPhoto && cachedPhotoId) {
          const r = await tgSendPhotoIdOrUrl(uid, cachedPhotoId, photoCaption);
          if (r.ok) {
            ok = true;
            if (!isCaptionShort && text) await tgSendMessage(uid, text);
          } else if (r.desc && /blocked|forbidden|deactivated|not found/i.test(r.desc)) {
            blockedUids.push(uid);
          }
        } else {
          const r = await tgSendMessage(uid, text);
          if (r.ok) {
            ok = true;
          } else if (r.desc && /blocked|forbidden|deactivated|not found/i.test(r.desc)) {
            blockedUids.push(uid);
          }
        }
        if (ok) sent++; else failed++;
      } catch (err) {
        failed++;
        if (/blocked|forbidden|deactivated|not found/i.test(err.message)) {
          blockedUids.push(uid);
        }
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  if (blockedUids.length > 0) {
    try {
      const stmt = db.prepare('UPDATE users SET bot_blocked = 1 WHERE user_id = ?');
      const updateMany = db.transaction((uids) => {
        for (const u of uids) stmt.run(u);
      });
      updateMany(blockedUids);
    } catch (_) {}
  }

  logAudit(adminName, 'notice_broadcast_complete', `target=all hasPhoto=${hasPhoto} sent=${sent} failed=${failed} blocked=${blockedUids.length}`);
}

router.get('/', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_banned,0)=0 AND COALESCE(bot_blocked,0)=0').get().c;
  res.render('notice', {
    msg: req.query.msg || null,
    totalUsers,
    botTokenSet: !!BOT_TOKEN,
  });
});

router.post('/send', upload.single('photo'), async (req, res) => {
  const text = (req.body.text || '').trim();
  const target = (req.body.target || 'all').trim();
  const imageUrl = (req.body.image_url || '').trim();
  const file = req.file;

  if (!text && !file && !imageUrl) {
    return res.redirect('/notice?msg=' + encodeURIComponent('❌ নোটিশের মেসেজ অথবা ছবি প্রদান করুন!'));
  }
  if (!BOT_TOKEN) {
    return res.redirect('/notice?msg=' + encodeURIComponent('❌ BOT_TOKEN missing in .env'));
  }

  const adminName = (req.session && req.session.admin) || 'Web Admin';

  if (target === 'all') {
    const recipients = db.prepare('SELECT user_id FROM users WHERE COALESCE(is_banned,0)=0 AND COALESCE(bot_blocked,0)=0').all().map(r => r.user_id);
    
    // Non-blocking high speed background broadcast
    runAsyncBroadcast({ recipients, text, file, imageUrl, adminName }).catch(err => {
      console.error('[notice] broadcast error:', err);
    });

    logAudit(adminName, 'notice_send_initiated', `target=all total=${recipients.length} hasPhoto=${!!(file||imageUrl)}`);
    return res.redirect('/notice?msg=' + encodeURIComponent(`🚀 নোটিশ পাঠানো ব্যাকগ্রাউন্ডে শুরু হয়েছে (${recipients.length} জন সক্রিয় ইউজার)! এটি প্রায় ১-২ মিনিটের মধ্যে সম্পন্ন হবে।`));
  } else {
    // Single user instant send
    const id = parseInt(target, 10);
    if (!id) return res.redirect('/notice?msg=' + encodeURIComponent('❌ Invalid user_id'));

    let sent = false;
    try {
      if (file) {
        const r = await tgSendPhotoBuffer(id, file.buffer, file.originalname, text);
        sent = r.ok;
      } else if (imageUrl) {
        const r = await tgSendPhotoIdOrUrl(id, imageUrl, text);
        sent = r.ok;
      } else {
        const r = await tgSendMessage(id, text);
        sent = r.ok;
      }
    } catch (_) {}

    logAudit(adminName, 'notice_single_send', `target=${id} sent=${sent}`);
    return res.redirect('/notice?msg=' + encodeURIComponent(sent ? `✅ ইউজার ${id}-কে নোটিশ সফলভাবে পাঠানো হয়েছে!` : `❌ ইউজার ${id}-কে নোটিশ পাঠানো ব্যর্থ হয়েছে।`));
  }
});

module.exports = router;
