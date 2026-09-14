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

router.get('/', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_banned,0)=0').get().c;
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

  let recipients = [];
  if (target === 'all') {
    recipients = db.prepare('SELECT user_id FROM users WHERE COALESCE(is_banned,0)=0').all().map(r => r.user_id);
  } else {
    const id = parseInt(target, 10);
    if (!id) return res.redirect('/notice?msg=' + encodeURIComponent('❌ Invalid user_id'));
    recipients = [id];
  }

  let sent = 0, failed = 0;
  const hasPhoto = !!(file || imageUrl);

  if (hasPhoto) {
    let cachedPhotoId = imageUrl || null;
    const isCaptionShort = text.length <= 1024;
    const photoCaption = isCaptionShort ? text : '';

    for (let i = 0; i < recipients.length; i++) {
      const uid = recipients[i];
      try {
        let photoSent = false;
        if (cachedPhotoId) {
          // Fast send using Telegram file_id or URL
          const r = await tgSendPhotoIdOrUrl(uid, cachedPhotoId, photoCaption);
          if (r.ok) photoSent = true;
        } else if (file) {
          // Upload buffer once to obtain Telegram file_id
          const r = await tgSendPhotoBuffer(uid, file.buffer, file.originalname, photoCaption);
          if (r.ok) {
            photoSent = true;
            if (r.fileId) cachedPhotoId = r.fileId;
          }
        }

        if (photoSent) {
          // If text was too long for caption (>1024 chars), send text as follow-up message
          if (!isCaptionShort && text) {
            await tgSendMessage(uid, text);
          }
          sent++;
        } else {
          failed++;
        }
      } catch (_) {
        failed++;
      }
      await new Promise(r => setTimeout(r, 40));
    }
  } else {
    // Pure text notice
    for (const uid of recipients) {
      try {
        const r = await tgSendMessage(uid, text);
        if (r.ok) sent++; else failed++;
      } catch (_) { failed++; }
      await new Promise(r => setTimeout(r, 40));
    }
  }

  logAudit('admin', 'notice_send', `target=${target} hasPhoto=${hasPhoto} sent=${sent} failed=${failed}`);
  res.redirect('/notice?msg=' + encodeURIComponent(`✅ Notice Sent: ${sent}, Failed: ${failed}`));
});

module.exports = router;
