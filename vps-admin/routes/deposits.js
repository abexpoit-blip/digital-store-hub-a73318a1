const express = require('express');
const { db } = require('../db');
const router = express.Router();

function classifyDeposit(row) {
  const amt = Number(row.amount || 0);
  const method = String(row.method || '').toLowerCase();
  const admin = String(row.admin_name || '').toLowerCase();
  const sender = String(row.sender_num || '').toLowerCase();
  const txn = String(row.transaction_id || '').toUpperCase();

  if (method.includes('binance') || admin.includes('binance') || sender.includes('binance') ||
      (amt > 0 && amt % 125 === 0 && (admin === 'sam' || admin.includes('basic trick')) && !method && !txn)) {
    return 'binance';
  }
  if (admin.includes('nagad') || method.includes('nagad') || sender.includes('nagad') || txn.startsWith('75Z')) {
    return 'nagad';
  }
  if (admin.includes('bkash') || method.includes('bkash') || sender.includes('bkash') || txn.startsWith('DI') || txn.startsWith('BL')) {
    return 'bkash';
  }
  if (method.includes('zinipay')) {
    if (admin.includes('nagad')) return 'nagad';
    return 'bkash';
  }
  return 'other';
}

function getWeeklyStats() {
  const now = new Date();
  const bstNow = new Date(now.getTime() + (6 * 3600 * 1000) + (now.getTimezoneOffset() * 60 * 1000));
  
  const days = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayNamesBn = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(bstNow.getTime() - (i * 24 * 3600 * 1000));
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const dayOfWeek = d.getDay();
    days.push({
      date: dateStr,
      dayName: dayNames[dayOfWeek],
      dayNameBn: dayNamesBn[dayOfWeek],
      isToday: i === 0,
      isYesterday: i === 1,
      total: 0,
      count: 0,
      bkash: 0,
      bkashCount: 0,
      nagad: 0,
      nagadCount: 0,
      binance: 0,
      binanceCount: 0,
      other: 0,
      otherCount: 0
    });
  }

  const startDate = days[days.length - 1].date;
  const approvedRows = db.prepare(`
    SELECT req_id, user_id, amount, method, admin_name, sender_num, transaction_id,
           COALESCE(date, date(datetime(timestamp, 'unixepoch', '+6 hours'))) AS dep_date
    FROM payment_logs
    WHERE status = 'approved'
      AND COALESCE(date, date(datetime(timestamp, 'unixepoch', '+6 hours'))) >= ?
  `).all(startDate);

  const dayMap = new Map();
  days.forEach(d => dayMap.set(d.date, d));

  const totals = {
    total: 0,
    count: 0,
    bkash: 0,
    bkashCount: 0,
    nagad: 0,
    nagadCount: 0,
    binance: 0,
    binanceCount: 0,
    other: 0,
    otherCount: 0
  };

  for (const row of approvedRows) {
    const day = dayMap.get(row.dep_date);
    if (!day) continue;

    const amt = Number(row.amount || 0);
    const cat = classifyDeposit(row);

    day.total += amt;
    day.count += 1;
    day[cat] += amt;
    day[`${cat}Count`] += 1;

    totals.total += amt;
    totals.count += 1;
    totals[cat] += amt;
    totals[`${cat}Count`] += 1;
  }

  return { days, totals };
}

router.get('/', (req, res) => {
  const status = req.query.status || 'all';
  const q = (req.query.q || '').trim();

  let where = '1=1';
  const params = [];
  if (status !== 'all') { where += ' AND status = ?'; params.push(status); }
  if (q) {
    // Search across user_id, username, sender phone/id, transaction id, req_id
    where += ` AND (
      LOWER(COALESCE(username,'')) LIKE ?
      OR CAST(user_id AS TEXT) LIKE ?
      OR LOWER(COALESCE(sender_num,'')) LIKE ?
      OR LOWER(COALESCE(transaction_id,'')) LIKE ?
      OR LOWER(COALESCE(req_id,'')) LIKE ?
    )`;
    const like = `%${q.toLowerCase()}%`;
    params.push(like, `%${q}%`, like, like, like);
  }

  const deposits = db.prepare(
    `SELECT * FROM payment_logs WHERE ${where} ORDER BY COALESCE(timestamp,0) DESC LIMIT 300`
  ).all(...params);

  // Enrich each deposit with telegram username from users table (reliable cross-reference)
  const userStmt = db.prepare('SELECT username, balance, is_banned FROM users WHERE user_id = ?');
  deposits.forEach(d => {
    if (d.user_id) {
      const u = userStmt.get(d.user_id);
      if (u) {
        d._tg_username = u.username;
        d._tg_balance = u.balance;
        d._tg_banned = u.is_banned;
      }
    }
  });

  const summary = db.prepare(
    `SELECT status, COUNT(*) AS c, COALESCE(SUM(amount),0) AS s FROM payment_logs GROUP BY status`
  ).all();

  const weeklyStats = getWeeklyStats();

  res.render('deposits', { deposits, summary, status, q, weeklyStats });
});

module.exports = router;
