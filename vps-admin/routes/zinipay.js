// =====================================================================
//  ZiniPay automatic deposit gateway
//  Routes:
//    POST /zinipay/create-invoice  — bot calls this (shared-secret auth)
//    POST /zinipay/webhook         — ZiniPay calls this after payment
//    GET  /zinipay/return          — user redirected here after pay/cancel
//  All public (no admin login required). Webhook security = Verify API call.
// =====================================================================
const express = require('express');
const { db, logAudit } = require('../db');
const router = express.Router();

const ZINIPAY_API_KEY     = process.env.ZINIPAY_API_KEY || '';
const ZINIPAY_BASE        = 'https://api.zinipay.com/v1/payment';
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const SHARED_SECRET       = process.env.DOWNLOAD_SECRET || '';     // bot ↔ admin
const PUBLIC_BASE         = process.env.ZINIPAY_PUBLIC_BASE || 'https://pay.nexus-x.cloud';
const BOT_USERNAME        = process.env.BOT_USERNAME || 'btidsellerbot'; // without @

// ---------- ensure ZiniPay columns exist (idempotent) ----------
try {
  const cols = ['invoice_id TEXT', 'method TEXT'];
  for (const c of cols) {
    try { db.exec(`ALTER TABLE payment_logs ADD COLUMN ${c}`); } catch (_) {}
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pl_invoice ON payment_logs(invoice_id)`); } catch (_) {}
} catch (e) { console.warn('[zinipay] migrate skip:', e.message); }

// ---------- helpers ----------
async function tgNotify(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (e) { console.error('[zinipay] tg notify fail:', e.message); }
}

function isPaidStatus(vdata) {
  const status = (vdata.status || vdata.payment_status || '').toString().toUpperCase();
  return status === 'COMPLETED' || status === 'SUCCESS' || status === 'PAID' || status === 'TRUE' || vdata.status === true;
}

async function verifyAndApprove(invoice_id, source = 'manual') {
  if (!invoice_id) return { approved: false, error: 'missing invoice_id' };

  const vr = await fetch(`${ZINIPAY_BASE}/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'zini-api-key': ZINIPAY_API_KEY,
      'zinipay-api-key': ZINIPAY_API_KEY
    },
    body: JSON.stringify({ invoice_id })
  });
  const vdata = await vr.json().catch(() => ({}));
  // Quiet logging: auto-reconcile-এ শুধু status লিখি (full JSON spam বন্ধ → CPU/disk বাঁচে)
  if (source === 'auto-reconcile' && !isPaidStatus(vdata)) {
    // silent — pending/failed invoice প্রতি cycle এ log করার দরকার নেই
  } else {
    console.log('[zinipay verify]', source, vr.status, invoice_id, JSON.stringify(vdata));
  }


  const row = db.prepare(`SELECT * FROM payment_logs WHERE invoice_id = ?`).get(invoice_id);
  if (!row) {
    console.warn('[zinipay] no matching row for invoice', invoice_id);
    return { approved: false, noRow: true, status: vdata.status || vdata.payment_status || null };
  }
  if (row.status === 'approved') return { alreadyApproved: true };
  if (!vr.ok || !isPaidStatus(vdata)) {
    return { approved: false, status: vdata.status || vdata.payment_status || null };
  }

  const verifiedAmount = parseInt(vdata.amount || row.amount, 10);
  const txnId = vdata.transaction_id || vdata.trxId || vdata.trxID || vdata.txn_id || '';
  const senderPhone = vdata.sender_number || vdata.sender || vdata.senderNumber || '';
  const payMethod = vdata.payment_method || vdata.provider || 'bkash/nagad';

  const tx = db.transaction(() => {
    const updated = db.prepare(
      `UPDATE payment_logs
         SET status='approved', amount=?, transaction_id=?, sender_num=?, admin_name=?
       WHERE req_id=? AND status='pending'`
    ).run(verifiedAmount, txnId, senderPhone, `ZiniPay-${payMethod}`, row.req_id);

    if (updated.changes > 0) {
      db.prepare(`INSERT OR IGNORE INTO users (user_id, balance) VALUES (?, 0)`).run(row.user_id);
      db.prepare(`UPDATE users SET balance = COALESCE(balance,0) + ? WHERE user_id = ?`)
        .run(verifiedAmount, row.user_id);
    }
    return updated.changes;
  });
  const changes = tx();
  if (!changes) return { alreadyApproved: true };

  logAudit(`zinipay-${source}`, 'auto-approve', `user=${row.user_id} amt=${verifiedAmount} inv=${invoice_id} txn=${txnId}`);
  tgNotify(row.user_id,
    `✅ *Deposit Successful!*\n\n💰 Amount: *${verifiedAmount}৳*\n🧾 TXN: \`${txnId || 'N/A'}\`\n💳 Method: ${payMethod}\n\nব্যালেন্স এ যোগ হয়েছে। ধন্যবাদ!`
  );

  return { approved: true, amount: verifiedAmount, transaction_id: txnId };
}

// =====================================================================
// 1) Bot creates invoice via this endpoint (shared-secret protected)
// =====================================================================
router.post('/create-invoice', express.json(), async (req, res) => {
  try {
    const { secret, user_id, username, amount } = req.body || {};
    if (!SHARED_SECRET || secret !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'bad secret' });
    }
    const amt = parseInt(amount, 10);
    if (!user_id || !amt || amt < 10) {
      return res.status(400).json({ ok: false, error: 'invalid amount (min 10)' });
    }
    if (!ZINIPAY_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ZINIPAY_API_KEY missing' });
    }

    const req_id = 'zp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const payload = {
      cus_name: username || `user_${user_id}`,
      cus_email: `u${user_id}@bot.local`,
      amount: amt,
      redirect_url: `${PUBLIC_BASE}/zinipay/return?status=success&r=${req_id}`,
      cancel_url:   `${PUBLIC_BASE}/zinipay/return?status=cancel&r=${req_id}`,
      webhook_url:  `${PUBLIC_BASE}/zinipay/webhook`,
      metadata: { req_id, user_id: String(user_id) }
    };

    const r = await fetch(`${ZINIPAY_BASE}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'zini-api-key': ZINIPAY_API_KEY },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok || !data || (!data.payment_url && !data.url)) {
      console.error('[zinipay] create fail:', r.status, data);
      return res.status(502).json({ ok: false, error: 'zinipay create failed', detail: data });
    }
    const payment_url = data.payment_url || data.url;
    // CRITICAL FIX: ZiniPay create response does NOT include invoice_id field.
    // The real verifiable invoice_id is the LAST PATH SEGMENT of payment_url.
    // `val_id` is NOT accepted by /verify endpoint (returns "Invoice not found").
    let invoice_id = data.invoice_id || data.id || data.invoiceId || null;
    if (!invoice_id && payment_url) {
      try {
        const u = new URL(payment_url);
        const seg = u.pathname.split('/').filter(Boolean).pop();
        if (seg && /^[0-9a-f-]{20,}$/i.test(seg)) invoice_id = seg;
      } catch (_) {}
    }
    console.log('[zinipay create] req_id=%s invoice_id=%s val_id=%s', req_id, invoice_id, data.val_id);

    // Insert pending row
    db.prepare(
      `INSERT INTO payment_logs (req_id, user_id, username, amount, status, date, admin_name, timestamp, invoice_id, method)
       VALUES (?, ?, ?, ?, 'pending', ?, 'ZiniPay-Auto', ?, ?, 'zinipay')`
    ).run(
      req_id, user_id, username || '', amt,
      new Date().toISOString().slice(0, 10),
      Date.now() / 1000,
      invoice_id
    );

    res.json({ ok: true, payment_url, invoice_id, req_id });
  } catch (e) {
    console.error('[zinipay] create-invoice error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================================================
// 2) Webhook — ZiniPay POSTs { invoice_id, status } here
//    Security: re-Verify via API (ZiniPay webhooks have NO signature)
// =====================================================================
async function handleWebhook(req, res) {
  try {
    console.log('[zinipay webhook]', JSON.stringify({ body: req.body || {}, query: req.query || {} }));
    const invoice_id = req.body?.invoice_id || req.body?.invoiceId || req.query?.invoice_id || req.query?.invoiceId;
    if (!invoice_id) return res.status(400).send('no invoice_id');
    const result = await verifyAndApprove(invoice_id, 'webhook');
    if (!result.approved && !result.alreadyApproved) console.warn('[zinipay] not approved yet', invoice_id, result.status || result.error || 'unknown');
    res.status(200).send('ok');
  } catch (e) {
    console.error('[zinipay webhook] error:', e);
    res.status(200).send('ok'); // always 200 so ZiniPay doesn't retry forever
  }
}

router.post('/webhook', express.json(), handleWebhook);
router.get('/webhook', handleWebhook);

// =====================================================================
// 3) Return page — user redirected here after pay/cancel
//    Instant redirect to Telegram bot — no admin URL exposure
// =====================================================================
router.get('/return', (req, res) => {
  const status = req.query.status === 'success' ? 'paid' : 'cancel';
  const tgUrl = `https://t.me/${BOT_USERNAME}?start=${status}`;
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Payment ${status}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=${tgUrl}">
<style>body{font-family:system-ui;background:#0f172a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}</style>
</head><body><div>
<h2>${status === 'paid' ? '✅ Payment Successful' : '❌ Payment Cancelled'}</h2>
<p>Telegram bot এ ফিরিয়ে নিচ্ছি...</p>
<p><a style="color:#60a5fa" href="${tgUrl}">এখানে ক্লিক করুন</a></p>
</div><script>setTimeout(()=>location.href=${JSON.stringify(tgUrl)},300)</script>
</body></html>`);
});

// =====================================================================
// 4) Auto-cleanup — pending invoices older than 24h → mark as 'failed'
//    Runs every 30 minutes. User notified on Telegram so they can retry.
// =====================================================================
const CLEANUP_AGE_SECONDS = 24 * 60 * 60; // 24 hours
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function cleanupStalePending() {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - CLEANUP_AGE_SECONDS;
    const stale = db.prepare(
      `SELECT req_id, user_id, amount, invoice_id
         FROM payment_logs
        WHERE status = 'pending'
          AND method = 'zinipay'
          AND COALESCE(timestamp, 0) < ?`
    ).all(cutoff);

    if (!stale.length) return;
    console.log(`[zinipay cleanup] found ${stale.length} stale pending invoices (>24h)`);

    const upd = db.prepare(
      `UPDATE payment_logs SET status='failed', admin_name='Auto-Cleanup-24h' WHERE req_id=? AND status='pending'`
    );

    for (const row of stale) {
      const r = upd.run(row.req_id);
      if (r.changes > 0) {
        logAudit('zinipay-cleanup', 'auto-fail-24h', `user=${row.user_id} amt=${row.amount} inv=${row.invoice_id || '-'} req=${row.req_id}`);
        // Notify user so they can retry
        tgNotify(row.user_id,
          `⏰ *Deposit Request Expired*\n\n` +
          `আপনার *${row.amount}৳* এর pending deposit ২৪ ঘণ্টার মধ্যে complete হয়নি, তাই auto-cancel করা হলো।\n\n` +
          `👉 আবার চেষ্টা করতে *💳 ব্যালেন্স অ্যাড* মেনু থেকে নতুন payment শুরু করুন।`
        );
      }
    }
  } catch (e) {
    console.error('[zinipay cleanup] error:', e.message);
  }
}

// Run once at boot (after 1 min delay), then every 30 min
setTimeout(cleanupStalePending, 60 * 1000);
setInterval(cleanupStalePending, CLEANUP_INTERVAL_MS);
console.log('[zinipay] auto-cleanup scheduled: every 30 min, threshold=24h');

// Manual trigger endpoint (admin-only via download secret) — useful for testing
router.post('/cleanup-now', express.json(), async (req, res) => {
  const { secret } = req.body || {};
  if (!SHARED_SECRET || secret !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  await cleanupStalePending();
  res.json({ ok: true, message: 'cleanup triggered' });
});

try {
  require('./zinipay-reconcile').attach(verifyAndApprove);
} catch (e) {
  console.error('[reconcile] attach failed:', e.message);
}

module.exports = router;

