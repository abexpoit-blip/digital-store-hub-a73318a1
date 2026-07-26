const express = require('express');
const crypto = require('crypto');
const { db, logAudit } = require('../db');
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
  const filter = req.query.filter || 'all'; // all | banned | active
  let sql = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  if (q) {
    sql += ' AND (LOWER(username) LIKE ? OR CAST(user_id AS TEXT) LIKE ?)';
    params.push(`%${q.toLowerCase()}%`, `%${q}%`);
  }
  if (filter === 'banned') sql += ' AND COALESCE(is_banned,0) = 1';
  else if (filter === 'active') sql += ' AND COALESCE(is_banned,0) = 0';
  sql += ' ORDER BY balance DESC LIMIT 300';

  const users = db.prepare(sql).all(...params);
  const counts = {
    all: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    banned: db.prepare('SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_banned,0)=1').get().c,
  };
  counts.active = counts.all - counts.banned;

  res.render('users', { users, q, filter, counts, msg: req.query.msg || null });
});

router.get('/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId)) return res.status(400).render('error', { message: 'Invalid user id' });
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  if (!user) return res.status(404).render('error', { message: 'User not found' });

  const sales = db.prepare('SELECT * FROM sales WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(userId);
  const deposits = db.prepare(
    'SELECT * FROM payment_logs WHERE user_id = ? ORDER BY COALESCE(timestamp,0) DESC LIMIT 100'
  ).all(userId);
  // Backfill deposit display date when 'date' column is empty
  deposits.forEach(d => {
    if (!d.date && d.timestamp) d.date = fmtDate(d.timestamp);
  });

  const deliveredBySale = {};
  const unlinkedDeliveries = [];
  try {
    const allDeliveries = db.prepare(
      `SELECT id, sale_id, category, stock_id, data, source, delivered_at
       FROM delivery_archive WHERE user_id = ? ORDER BY id DESC LIMIT 500`
    ).all(userId);
    allDeliveries.forEach(d => {
      d._date = fmtDate(d.delivered_at);
      if (d.sale_id) (deliveredBySale[d.sale_id] = deliveredBySale[d.sale_id] || []).push(d);
      else unlinkedDeliveries.push(d);
    });
  } catch (e) {}

  // Public download link (HMAC) per sale — same secret bot uses
  const secret = process.env.DOWNLOAD_SECRET || 'change-me-download-secret';
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  sales.forEach(s => {
    const sig = crypto.createHmac('sha256', secret).update(String(s.id)).digest('hex').slice(0, 16);
    s._download = `${baseUrl}/o/${s.id}/${sig}`;
  });

  const totalSpent = sales.reduce((a, b) => a + (b.total || 0), 0);
  const totalDeposited = deposits
    .filter(d => d.status === 'approved')
    .reduce((a, b) => a + (b.amount || 0), 0);

  // --- Manual balance (admin-given) history ---
  let manualCredits = [];
  let manualTotal = 0;
  try {
    manualCredits = db.prepare(
      'SELECT * FROM manual_credits WHERE user_id = ? ORDER BY id DESC LIMIT 100'
    ).all(userId);
    manualCredits.forEach(m => { m._date = fmtDate(m.created_at); });
    manualTotal = manualCredits.reduce((a, b) => a + (b.delta || 0), 0);
  } catch (_) {}

  // --- Replace request history (how many times this user asked) ---
  let replaceHistory = [];
  const replaceStats = { total: 0, pending: 0, collected: 0, rejected: 0 };
  try {
    replaceHistory = db.prepare(
      'SELECT * FROM replace_requests WHERE user_id = ? ORDER BY id DESC LIMIT 100'
    ).all(userId);
    replaceHistory.forEach(r => { r._date = fmtDate(r.created_at); });
    replaceStats.total = replaceHistory.length;
    replaceHistory.forEach(r => {
      const s = (r.status || 'pending').toLowerCase();
      if (replaceStats[s] !== undefined) replaceStats[s] += 1;
    });
  } catch (_) {}

  res.render('user-detail', {
    user, sales, deposits, totalSpent, totalDeposited,
    deliveredBySale, unlinkedDeliveries,
    manualCredits, manualTotal, replaceHistory, replaceStats,
    msg: req.query.msg || null
  });
});

router.post('/:id/balance', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const delta = parseInt(req.body.delta, 10);
  const reason = (req.body.reason || '').replace(/"/g, "'").trim();
  if (!Number.isFinite(userId)) return res.redirect('/users?msg=Invalid+user');
  if (!Number.isFinite(delta) || delta === 0) return res.redirect(`/users/${userId}?msg=Invalid+amount`);
  // Atomic balance update — no read-then-write race
  const upd = db.prepare(
    'UPDATE users SET balance = COALESCE(balance,0) + ? WHERE user_id = ? AND (? > 0 OR COALESCE(balance,0) + ? >= 0)'
  ).run(delta, userId, delta, delta);
  if (upd.changes === 0) {
    return res.redirect(`/users/${userId}?msg=` + encodeURIComponent('❌ User not found or insufficient balance'));
  }
  const row = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(userId);
  logAudit('admin', 'balance_adjust',
    `user=${userId} delta=${delta} new=${row ? row.balance : '?'} reason="${reason}"`);
  res.redirect(`/users/${userId}?msg=` + encodeURIComponent(`Balance updated: ${delta > 0 ? '+' : ''}${delta} Tk`));
});

router.post('/:id/ban', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!Number.isFinite(userId)) return res.redirect('/users?msg=Invalid+user');
  const banned = req.body.banned === '1' ? 1 : 0;
  db.prepare('UPDATE users SET is_banned = ? WHERE user_id = ?').run(banned, userId);
  logAudit('admin', banned ? 'ban_user' : 'unban_user', `user=${userId}`);
  res.redirect(`/users/${userId}?msg=` + encodeURIComponent(banned ? 'User banned 🚫' : 'User unbanned ✅'));
});

router.post('/:id/delete', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId) return res.redirect('/users');
  const confirm = (req.body.confirm || '').trim();
  if (confirm !== String(userId)) {
    return res.redirect(`/users/${userId}?msg=` + encodeURIComponent('❌ Confirmation user_id mismatch'));
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sales WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM payment_logs WHERE user_id = ?').run(userId);
    try { db.prepare('DELETE FROM delivery_archive WHERE user_id = ?').run(userId); } catch (_) {}
    try { db.prepare('DELETE FROM replace_requests WHERE user_id = ?').run(userId); } catch (_) {}
  });
  tx();
  logAudit('admin', 'delete_user', `user=${userId}`);
  res.redirect('/users?msg=' + encodeURIComponent(`🗑️ User ${userId} deleted`));
});

module.exports = router;
