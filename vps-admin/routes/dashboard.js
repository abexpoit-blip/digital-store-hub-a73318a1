const express = require('express');
const { db } = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const bannedUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_banned = 1').get().c;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance),0) AS s FROM users').get().s;

  // Today's deposits (approved). Using `date` text column (DD-MM-YYYY or similar). Fallback to timestamp.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;
  const todayDeposits = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS c FROM payment_logs WHERE status='approved' AND COALESCE(timestamp,0) >= ?"
  ).get(todayTs);

  const totalApproved = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM payment_logs WHERE status='approved'"
  ).get().s;

  const pendingPayments = db.prepare(
    "SELECT COUNT(*) AS c FROM payment_logs WHERE status='pending'"
  ).get().c;

  const stockByCategory = db.prepare(
    'SELECT category, COUNT(*) AS c FROM stock GROUP BY category ORDER BY c DESC'
  ).all();
  const totalStock = stockByCategory.reduce((a, b) => a + b.c, 0);

  const pendingReplaces = db.prepare(
    "SELECT COUNT(*) AS c FROM replace_requests WHERE status='pending'"
  ).get().c;

  const recentSales = db.prepare(
    'SELECT * FROM sales ORDER BY id DESC LIMIT 8'
  ).all();

  const totalOrders = db.prepare('SELECT COUNT(*) AS c FROM sales').get().c;

  const botStatus = db.prepare("SELECT value FROM config WHERE key='bot_status'").get();

  res.render('dashboard', {
    totalUsers, bannedUsers, totalBalance,
    todayDeposits, totalApproved, pendingPayments,
    stockByCategory, totalStock,
    pendingReplaces, recentSales, totalOrders,
    botStatus: botStatus ? botStatus.value : 'unknown',
    msg: req.query.msg || null
  });
});

// Toggle bot status (open/closed) — uses bot's existing config table
router.post('/bot-status', (req, res) => {
  const next = req.body.status === 'closed' ? 'closed' : 'open';
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('bot_status', ?)").run(next);
  const { logAudit } = require('../db');
  logAudit('admin', 'bot_status_change', next);
  res.redirect('/?msg=' + encodeURIComponent('Bot status: ' + next));
});

module.exports = router;
