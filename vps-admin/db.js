// Database connection — shares the SAME store.db with the Telegram bot
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'store.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // matches bot — safe for concurrent reads/writes
db.pragma('busy_timeout = 5000');

// --- Add NEW tables only. Bot's existing tables are untouched. ---
db.exec(`
  CREATE TABLE IF NOT EXISTS replace_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT,
    category TEXT,
    old_data TEXT,
    reason TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    collected_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS manual_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT,
    delta INTEGER NOT NULL,
    balance_after INTEGER,
    reason TEXT,
    admin_name TEXT DEFAULT 'admin',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_manual_credits_user ON manual_credits(user_id);
  CREATE INDEX IF NOT EXISTS idx_manual_credits_time ON manual_credits(created_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS delivery_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER,
    user_id INTEGER NOT NULL,
    username TEXT,
    category TEXT NOT NULL,
    stock_id INTEGER,
    data TEXT NOT NULL,
    source TEXT DEFAULT 'bot',
    delivered_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_user ON delivery_archive(user_id);
  CREATE INDEX IF NOT EXISTS idx_delivery_sale ON delivery_archive(sale_id);

  CREATE TABLE IF NOT EXISTS uid_history (
    uid TEXT PRIMARY KEY,
    category TEXT,
    first_uploaded_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    upload_count INTEGER DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_uid_history_last_seen ON uid_history(last_seen_at);

  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL,
    is_anonymous INTEGER DEFAULT 0,
    allows_multiple INTEGER DEFAULT 0,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft'
  );

  CREATE TABLE IF NOT EXISTS poll_sent_map (
    tg_poll_id TEXT PRIMARY KEY,
    poll_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    chat_message_id INTEGER,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_psm_poll ON poll_sent_map(poll_id);

  CREATE TABLE IF NOT EXISTS poll_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    tg_poll_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT,
    option_ids TEXT NOT NULL,
    voted_at INTEGER NOT NULL,
    UNIQUE(tg_poll_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pv_poll ON poll_votes(poll_id);
`);

// Auto-cleanup UID history older than 3 days (called on every upload check)
function cleanupOldUidHistory(days = 3) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    const r = db.prepare('DELETE FROM uid_history WHERE last_seen_at < ?').run(cutoff);
    return r.changes;
  } catch (e) { return 0; }
}



// Dedupe existing pending replace_requests, then create partial unique index
// to prevent the same user from submitting the same (category, old_data) twice while pending.
try {
  db.exec(`
    DELETE FROM replace_requests
    WHERE status='pending' AND id NOT IN (
      SELECT MIN(id) FROM replace_requests
      WHERE status='pending'
      GROUP BY user_id, COALESCE(category,''), COALESCE(old_data,'')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_replace_pending_unique
      ON replace_requests(user_id, category, old_data)
      WHERE status='pending';
  `);
} catch (e) {
  console.warn('[db] replace dedupe/index skipped:', e.message);
}

function logAudit(actor, action, details = '') {
  db.prepare('INSERT INTO audit_log (actor, action, details, timestamp) VALUES (?, ?, ?, ?)')
    .run(actor, action, details, Date.now());
}

module.exports = { db, logAudit, DB_PATH, cleanupOldUidHistory };
