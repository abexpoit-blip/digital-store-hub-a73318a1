// Manual balance credit tracking — who got admin-given balance, how often
const express = require('express');
const { db, logAudit } = require('../db');
const router = express.Router();
const BOT_TOKEN = process.env.BOT_TOKEN || '8364765061:AAEoT6w2l74JDowWUns2EC5OT8wEcIji9Y4';

function fmtDate(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(ts > 1e12 ? ts : ts * 1000);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  } catch (_) { return '-'; }
}

function resolveUserRecord(input) {
  input = String(input || '').trim();
  if (!input) return null;

  // 1. Numeric ID
  if (/^\d+$/.test(input)) {
    const uid = parseInt(input, 10);
    const u = db.prepare('SELECT user_id, username, balance FROM users WHERE user_id = ?').get(uid);
    if (u) return u;
    const byName = db.prepare('SELECT user_id, username, balance FROM users WHERE LOWER(username) = ?').get(input.toLowerCase());
    if (byName) return byName;
    return { user_id: uid, username: null, balance: 0, is_new: true };
  }

  const clean = input.replace(/^@/, '').trim().toLowerCase();
  const exactAt = '@' + clean;

  // 2. Exact match in users table
  const exact = db.prepare('SELECT user_id, username, balance FROM users WHERE LOWER(username) = ? OR LOWER(username) = ? LIMIT 1').get(exactAt, clean);
  if (exact) return exact;

  // 3. Fallback search in logs
  for (const tbl of ['payment_logs', 'sales', 'manual_credits']) {
    try {
      const log = db.prepare(`SELECT user_id FROM ${tbl} WHERE LOWER(username) = ? OR LOWER(username) = ? ORDER BY id DESC LIMIT 1`).get(exactAt, clean);
      if (log && log.user_id) {
        const u = db.prepare('SELECT user_id, username, balance FROM users WHERE user_id = ?').get(log.user_id);
        if (u) return u;
      }
    } catch (_) {}
  }

  // 4. Prefix match
  const pfx = db.prepare('SELECT user_id, username, balance FROM users WHERE LOWER(username) LIKE ? OR LOWER(username) LIKE ? LIMIT 2').all(clean + '%', exactAt + '%');
  if (pfx.length === 1) return pfx[0];

  return null;
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

router.post('/adjust', async (req, res) => {
  const targetInput = (req.body.target || '').trim();
  const action = (req.body.action || 'add').toLowerCase();
  const rawAmount = parseInt(req.body.amount, 10);
  const reason = (req.body.reason || '').replace(/"/g, "'").trim();
  const method = (req.body.method || 'manual').trim();

  if (!targetInput) return res.redirect('/credits?msg=' + encodeURIComponent('❌ ইউজার আইডি অথবা @username দিন'));
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) return res.redirect('/credits?msg=' + encodeURIComponent('❌ সঠিক পরিমাণ (টাকা) দিন'));

  const user = resolveUserRecord(targetInput);
  if (!user) {
    return res.redirect('/credits?msg=' + encodeURIComponent(`❌ ইউজার '${targetInput}' খুঁজে পাওয়া যায়নি`));
  }

  const userId = user.user_id;
  let username = user.username;
  const delta = action === 'cut' ? -rawAmount : rawAmount;

  let row = db.prepare('SELECT user_id, balance, username FROM users WHERE user_id = ?').get(userId);
  if (!row) {
    const fallbackName = username || (targetInput.startsWith('@') ? targetInput : `User_${userId}`);
    db.prepare('INSERT INTO users (user_id, username, balance, is_banned) VALUES (?, ?, 0, 0)').run(userId, fallbackName);
    row = { user_id: userId, balance: 0, username: fallbackName };
    username = fallbackName;
  }

  const oldBal = row.balance || 0;
  if (delta < 0 && oldBal + delta < 0) {
    return res.redirect('/credits?msg=' + encodeURIComponent(`❌ ইউজারের বর্তমান ব্যালেন্স (${oldBal}৳) থেকে ${rawAmount}৳ কর্তন করা সম্ভব নয়`));
  }

  const newBal = oldBal + delta;
  db.prepare('UPDATE users SET balance = ? WHERE user_id = ?').run(newBal, userId);

  const adminName = (req.session && req.session.admin && req.session.admin.username) ? req.session.admin.username : 'WebAdmin';
  const reasonText = reason || (delta > 0 ? 'WebAdmin Manual Add' : 'WebAdmin Manual Cut');

  try {
    const mcRes = db.prepare(
      `INSERT INTO manual_credits (user_id, username, delta, balance_after, reason, admin_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, username || '', delta, newBal, reasonText, adminName, Date.now());

    if (delta > 0) {
      const now = new Date();
      const bst = new Date(now.getTime() + (6 * 3600 * 1000) + (now.getTimezoneOffset() * 60 * 1000));
      const bstDate = bst.toISOString().slice(0, 10);
      const nowTs = Math.floor(now.getTime() / 1000);
      const reqId = 'manual_credit_' + (mcRes && mcRes.lastInsertRowid ? mcRes.lastInsertRowid : Date.now());
      const adminLabel = `${adminName} (${reasonText})`;

      db.prepare(`
        INSERT INTO payment_logs (req_id, user_id, username, amount, status, date, admin_name, timestamp, sender_num, method)
        VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)
      `).run(
        reqId,
        userId,
        username || '',
        delta,
        bstDate,
        adminLabel,
        nowTs,
        'Admin Manual',
        method
      );
    }
  } catch (e) {
    console.warn('[credits] manual_credits/payment_logs insert error:', e.message);
  }

  logAudit(adminName, 'balance_adjust', `user=${userId} (${username || ''}) delta=${delta} old=${oldBal} new=${newBal} reason="${reasonText}" method="${method}"`);

  let userNotified = false;
  try {
    const tgMsg = delta > 0
      ? `🎁 **ব্যালেন্স যুক্ত করা হয়েছে!**\n━━━━━━━━━━━━━━━━━━━━\n💰 যোগ করা পরিমাণ: **+${delta}৳**\n💳 বর্তমান ব্যালেন্স: **${newBal}৳**\n📝 বিবরণ: ${reasonText}\n━━━━━━━━━━━━━━━━━━━━\nধন্যবাদ!`
      : `⚠️ **ব্যালেন্স কর্তন করা হয়েছে!**\n━━━━━━━━━━━━━━━━━━━━\n🔻 কর্তন করা পরিমাণ: **${delta}৳**\n💳 বর্তমান ব্যালেন্স: **${newBal}৳**\n📝 কারণ: ${reasonText}\n━━━━━━━━━━━━━━━━━━━━`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: userId, text: tgMsg, parse_mode: 'Markdown' })
    });
    userNotified = true;
  } catch (err) {
    console.warn('[credits] tg notify error:', err.message);
  }

  const successMsg = `✅ ${username || userId}-এর ব্যালেন্স ${delta > 0 ? '+' : ''}${delta}৳ আপডেট হয়েছে (বর্তমান: ${newBal}৳)। ` + (userNotified ? 'টেলিগ্রাম নোটিফিকেশন পাঠানো হয়েছে।' : 'টেলিগ্রাম নোটিফিকেশন যায়নি।');
  res.redirect('/credits?msg=' + encodeURIComponent(successMsg));
});

module.exports = router;
