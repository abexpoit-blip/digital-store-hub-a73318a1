// Telegram native Poll system — create / broadcast / collect results.
// Uses Telegram Bot API directly via BOT_TOKEN in .env.
const express = require('express');
const { db, logAudit } = require('../db');
const router = express.Router();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;

async function tgCall(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
  const r = await fetch(TG(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({ ok: false }));
}

// ---------- LIST ----------
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(DISTINCT user_id) FROM poll_votes WHERE poll_id = p.id) AS vote_count
    FROM polls p
    ORDER BY p.id DESC
    LIMIT 200
  `).all();
  res.render('polls', {
    title: 'Polls',
    msg: req.query.msg || null,
    polls: rows,
    botTokenSet: !!BOT_TOKEN,
    currentPath: req.path,
  });
});

// ---------- NEW (form) ----------
router.get('/new', (req, res) => {
  res.render('poll-new', {
    title: 'New Poll',
    msg: null,
    botTokenSet: !!BOT_TOKEN,
    currentPath: req.path,
  });
});

// ---------- CREATE ----------
router.post('/create', (req, res) => {
  const question = (req.body.question || '').trim();
  const optionsRaw = (req.body.options || '').trim();
  const allows_multiple = req.body.allows_multiple ? 1 : 0;
  const is_anonymous = req.body.is_anonymous ? 1 : 0;
  const sendNow = req.body.send_now === '1';

  if (!question) return res.redirect('/polls?msg=' + encodeURIComponent('❌ Question empty'));
  if (question.length > 300) return res.redirect('/polls?msg=' + encodeURIComponent('❌ Question 300 char এর বেশি'));

  const options = optionsRaw.split('\n').map(s => s.trim()).filter(Boolean);
  if (options.length < 2 || options.length > 10) {
    return res.redirect('/polls?msg=' + encodeURIComponent('❌ কমপক্ষে 2টা, সর্বোচ্চ 10টা option দিন'));
  }
  if (options.some(o => o.length > 100)) {
    return res.redirect('/polls?msg=' + encodeURIComponent('❌ প্রতি option 100 char এর মধ্যে'));
  }

  const info = db.prepare(`
    INSERT INTO polls (question, options_json, is_anonymous, allows_multiple, created_by, created_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(question, JSON.stringify(options), is_anonymous, allows_multiple, 'web-admin', Date.now());

  logAudit('admin', 'poll_create', `id=${info.lastInsertRowid} q="${question.slice(0,60)}"`);

  if (sendNow) return res.redirect('/polls/' + info.lastInsertRowid + '/send');
  res.redirect('/polls?msg=' + encodeURIComponent('✅ Draft তৈরি হয়েছে (id=' + info.lastInsertRowid + ')'));
});

// ---------- DETAIL / RESULT ----------
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return res.status(404).render('error', { message: 'Poll not found' });

  const options = JSON.parse(poll.options_json);
  const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY voted_at DESC').all(id);

  const counts = options.map(() => 0);
  for (const v of votes) {
    try {
      const picks = JSON.parse(v.option_ids);
      for (const i of picks) if (counts[i] !== undefined) counts[i]++;
    } catch (_) {}
  }
  const total = votes.length;

  res.render('poll-detail', {
    title: 'Poll #' + id,
    msg: req.query.msg || null,
    poll,
    options,
    counts,
    total,
    votes,
    botTokenSet: !!BOT_TOKEN,
    currentPath: req.path,
  });
});

// ---------- SEND / BROADCAST ----------
router.get('/:id/send', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return res.redirect('/polls?msg=' + encodeURIComponent('❌ Poll not found'));
  if (!BOT_TOKEN) return res.redirect('/polls?msg=' + encodeURIComponent('❌ BOT_TOKEN missing in .env'));
  if (poll.status === 'closed') return res.redirect('/polls/' + id + '?msg=' + encodeURIComponent('❌ Poll closed'));

  const options = JSON.parse(poll.options_json);
  const users = db.prepare('SELECT user_id FROM users WHERE COALESCE(is_banned,0)=0 AND COALESCE(is_suspended,0)=0').all();

  const insertMap = db.prepare(`
    INSERT OR IGNORE INTO poll_sent_map (tg_poll_id, poll_id, user_id, chat_message_id, sent_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      const r = await tgCall('sendPoll', {
        chat_id: u.user_id,
        question: poll.question,
        options,
        is_anonymous: !!poll.is_anonymous,
        allows_multiple_answers: !!poll.allows_multiple,
        type: 'regular',
      });
      if (r.ok && r.result && r.result.poll) {
        insertMap.run(r.result.poll.id, id, u.user_id, r.result.message_id, Date.now());
        sent++;
      } else {
        failed++;
      }
    } catch (_) { failed++; }
    await new Promise(r => setTimeout(r, 40)); // ~25 msg/sec
  }

  db.prepare('UPDATE polls SET status=?, sent_count=sent_count+?, failed_count=failed_count+? WHERE id=?')
    .run('sent', sent, failed, id);

  logAudit('admin', 'poll_send', `id=${id} sent=${sent} failed=${failed}`);
  res.redirect('/polls/' + id + '?msg=' + encodeURIComponent(`✅ Sent: ${sent}, Failed: ${failed}`));
});

// ---------- CLOSE ----------
router.post('/:id/close', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return res.redirect('/polls?msg=' + encodeURIComponent('❌ Not found'));

  if (BOT_TOKEN) {
    const sent = db.prepare('SELECT user_id, chat_message_id FROM poll_sent_map WHERE poll_id = ? AND chat_message_id IS NOT NULL').all(id);
    for (const s of sent) {
      try { await tgCall('stopPoll', { chat_id: s.user_id, message_id: s.chat_message_id }); }
      catch (_) {}
      await new Promise(r => setTimeout(r, 35));
    }
  }
  db.prepare('UPDATE polls SET status=? WHERE id=?').run('closed', id);
  logAudit('admin', 'poll_close', `id=${id}`);
  res.redirect('/polls/' + id + '?msg=' + encodeURIComponent('✅ Closed'));
});

// ---------- DELETE ----------
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(id);
  db.prepare('DELETE FROM poll_sent_map WHERE poll_id = ?').run(id);
  db.prepare('DELETE FROM polls WHERE id = ?').run(id);
  logAudit('admin', 'poll_delete', `id=${id}`);
  res.redirect('/polls?msg=' + encodeURIComponent('🗑️ Deleted'));
});

// ---------- EXPORT CSV ----------
router.get('/:id/export', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!poll) return res.status(404).send('Not found');
  const options = JSON.parse(poll.options_json);
  const votes = db.prepare('SELECT * FROM poll_votes WHERE poll_id = ? ORDER BY voted_at').all(id);
  const lines = ['user_id,username,picked_options,voted_at'];
  for (const v of votes) {
    let picks = [];
    try {
      const arr = JSON.parse(v.option_ids);
      picks = arr.map(i => options[i] || ('#' + i));
    } catch (_) {}
    const t = new Date(v.voted_at).toISOString();
    lines.push([v.user_id, '"' + (v.username || '').replace(/"/g, '""') + '"',
                '"' + picks.join(' | ').replace(/"/g, '""') + '"', t].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="poll-${id}-votes.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
