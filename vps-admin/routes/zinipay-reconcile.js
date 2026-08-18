// =====================================================================
//  ZiniPay Auto-Reconciler  (Optimized v2)
//  - Runs every 5 min in background
//  - Adaptive backoff: hot invoices checked often, old ones less often
//  - Hard stop after MAX_ATTEMPTS → cleanup handles them at 24h
//  - Summary log only (no spam per invoice)
//  - Orphan recovery (no invoice_id) via ZiniPay list API
// =====================================================================
const { db } = require('../db');

const ZINIPAY_API_KEY = process.env.ZINIPAY_API_KEY || '';
const ZINIPAY_BASE    = 'https://api.zinipay.com/v1/payment';
const INTERVAL_MS     = 5 * 60 * 1000;   // 5 minutes
const LOOKBACK_HOURS  = 48;              // only check pending from last 48h
const MAX_ATTEMPTS    = 40;              // stop checking after ~5h of trying

// Adaptive schedule — skip invoice if recently checked
// attempts < 6  (first 30 min) → every cycle (5 min)
// attempts 6–18 (next hour)    → every 3 cycles (15 min)
// attempts > 18                → every 6 cycles (30 min)
function shouldCheck(state, cycleIdx) {
  if (state.attempts >= MAX_ATTEMPTS) return false;
  if (state.attempts < 6) return true;
  if (state.attempts < 18) return (cycleIdx - state.firstCycle) % 3 === 0;
  return (cycleIdx - state.firstCycle) % 6 === 0;
}

let _reconciling   = false;
let _verifyFn      = null;
let _cycleIdx      = 0;
const _invState    = new Map(); // invoice_id -> { attempts, firstCycle, lastStatus }

function attach(verifyFn) {
  _verifyFn = verifyFn;
  console.log('[reconcile] attached verifyAndApprove (optimized v2). interval=5m, max_attempts=40, lookback=48h');
  setTimeout(runReconcile, 30 * 1000);
  setInterval(runReconcile, INTERVAL_MS);
}

async function runReconcile() {
  if (_reconciling) return; // silent skip — was log spam
  if (!_verifyFn)   { console.warn('[reconcile] verify fn not attached'); return; }
  _reconciling = true;
  _cycleIdx++;
  const started = Date.now();
  let checked = 0, skipped = 0, recovered = 0, orphans = 0, stopped = 0;

  try {
    const cutoff = Date.now() / 1000 - (LOOKBACK_HOURS * 3600);

    // --- Phase 1: re-verify pending WITH invoice_id (adaptive) ---
    const withInv = db.prepare(
      `SELECT req_id, invoice_id FROM payment_logs
        WHERE method='zinipay' AND status='pending'
          AND invoice_id IS NOT NULL AND invoice_id != ''
          AND timestamp > ?`
    ).all(cutoff);

    // Clean up state for invoices no longer pending
    const stillPending = new Set(withInv.map(r => r.invoice_id));
    for (const k of _invState.keys()) {
      if (!stillPending.has(k)) _invState.delete(k);
    }

    for (const row of withInv) {
      let state = _invState.get(row.invoice_id);
      if (!state) {
        state = { attempts: 0, firstCycle: _cycleIdx, lastStatus: null };
        _invState.set(row.invoice_id, state);
      }
      if (state.attempts >= MAX_ATTEMPTS) {
        // ~5 ঘণ্টা try করেও paid হয়নি → failed মার্ক করে scan থেকে বাদ (CPU spam বন্ধ)
        try {
          db.prepare(
            `UPDATE payment_logs SET status='failed'
              WHERE req_id=? AND method='zinipay' AND status='pending'`
          ).run(row.req_id);
        } catch (_) {}
        _invState.delete(row.invoice_id);
        stopped++; continue;
      }
      if (!shouldCheck(state, _cycleIdx))  { skipped++; continue; }


      state.attempts++;
      checked++;
      try {
        const r = await _verifyFn(row.invoice_id, 'auto-reconcile');
        if (r && (r.approved || r.alreadyApproved)) {
          recovered++;
          _invState.delete(row.invoice_id); // done
        }
      } catch (e) { console.error('[reconcile] verify err inv=' + row.invoice_id, e && e.message ? e.message : e); }
    }

    // --- Phase 2: orphan match via ZiniPay list API (run every 6th cycle = 30 min) ---
    if (ZINIPAY_API_KEY && _cycleIdx % 6 === 0) {
      const orphanRows = db.prepare(
        `SELECT req_id, user_id, amount FROM payment_logs
          WHERE method='zinipay' AND status='pending'
            AND (invoice_id IS NULL OR invoice_id='')
            AND timestamp > ?`
      ).all(cutoff);

      if (orphanRows.length > 0) {
        const listVariants = [
          { url: `${ZINIPAY_BASE}/all`,      method: 'POST', body: { limit: 100 } },
          { url: `${ZINIPAY_BASE}/list`,     method: 'POST', body: { limit: 100 } },
          { url: `${ZINIPAY_BASE}/invoices`, method: 'GET',  body: null },
        ];

        let invoices = null;
        for (const v of listVariants) {
          try {
            const opts = {
              method: v.method,
              headers: { 'Content-Type': 'application/json', 'zini-api-key': ZINIPAY_API_KEY }
            };
            if (v.body) opts.body = JSON.stringify(v.body);
            const r = await fetch(v.url, opts);
            if (!r.ok) continue;
            const j = await r.json();
            const arr = Array.isArray(j) ? j : (j.data || j.invoices || j.results || []);
            if (Array.isArray(arr) && arr.length > 0) { invoices = arr; break; }
          } catch (_) {}
        }

        if (invoices) {
          const orphanByReqId = new Map(orphanRows.map(r => [r.req_id, r]));
          for (const inv of invoices) {
            const status = String(inv.status || inv.payment_status || '').toUpperCase();
            if (status !== 'COMPLETED' && status !== 'SUCCESS' && status !== 'PAID') continue;
            const reqId     = inv.metadata?.req_id;
            const invoiceId = inv.invoice_id || inv.id;
            if (!reqId || !invoiceId || !orphanByReqId.has(reqId)) continue;

            try {
              db.prepare(
                `UPDATE payment_logs SET invoice_id=? WHERE req_id=? AND (invoice_id IS NULL OR invoice_id='')`
              ).run(invoiceId, reqId);
              const r = await _verifyFn(invoiceId, 'reconcile-orphan');
              if (r && (r.approved || r.alreadyApproved)) { recovered++; orphans++; }
            } catch (e) {
              console.error('[reconcile] orphan recover failed', reqId, e.message);
            }
          }
        }
      }
    }

    const ms = Date.now() - started;
    // Only log when something happened (reduce noise drastically)
    if (checked || recovered || stopped) {
      console.log(`[reconcile] cycle#${_cycleIdx} ${ms}ms — checked=${checked} skipped=${skipped} recovered=${recovered} orphans=${orphans} stopped=${stopped}`);
    }
  } catch (e) {
    console.error('[reconcile] error:', e.message);
  } finally {
    _reconciling = false;
  }
}

module.exports = { attach, runReconcile };
