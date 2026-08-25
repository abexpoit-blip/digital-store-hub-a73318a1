#!/usr/bin/env python3
"""
=====================================================================
 BUY LIMIT PATCH v1  —  10 pcs / 10 min per user
=====================================================================
 নিয়ম:
   • একজন user ১০ মিনিটে সর্বোচ্চ 10 pcs ID কিনতে পারবে
   • প্রথম কেনার মুহূর্ত থেকেই 10 মিনিটের counting শুরু
   • কেনার সাথে সাথেই দেখাবে: কত pcs বাকি + কত সময় বাকি
   • limit শেষ হলে warning: "আর X মিনিট Y সেকেন্ড পরে আবার নিতে পারবেন"

 চালানো (VPS):
   cd /root
   python3 /root/digital-store-hub/vps-admin/apply-buylimit-v1.py --inspect   # structure দেখাবে
   python3 /root/digital-store-hub/vps-admin/apply-buylimit-v1.py             # patch করবে

 Revert:
   cp store.py.backup-buylimit-<ts> store.py && pm2 restart nexus-bot
=====================================================================
"""
import os, sys, re, time, shutil, py_compile

STORE_PY = "store.py"
MARKER   = "# [BUYLIMIT_V1]"

HELPER = '''
# [BUYLIMIT_V1] ---- 10 pcs / 10 min limit (শুধু FB 1000xx) ----
BUYLIMIT_MAX    = 10
BUYLIMIT_WINDOW = 600  # seconds
# শুধু এই category গুলোতে limit; fb61 / tempid / অন্যসব unlimited
BUYLIMIT_CATS   = {"fb1000", "fb1000xx", "1000xx"}

def _bl_limited(cat):
    try:
        return str(cat or "").strip().lower() in BUYLIMIT_CATS
    except Exception:
        return False

def _bl_conn():
    try:
        return _dbc()
    except Exception:
        import sqlite3 as _s
        _p = globals().get("DB_FILE") or globals().get("DB_PATH") or globals().get("DB") or "store.db"
        if not isinstance(_p, str):
            _p = "store.db"
        c = _s.connect(_p, timeout=15)
        try:
            c.execute("PRAGMA busy_timeout=15000")
        except Exception:
            pass
        return c

def _bl_init(cur):
    cur.execute("""CREATE TABLE IF NOT EXISTS buy_limit (
        user_id INTEGER PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0)""")

def _bl_state(uid):
    """(used_in_window, seconds_left) — window expired হলে (0, 0)"""
    import time as _t
    now = int(_t.time())
    conn = _bl_conn()
    try:
        cur = conn.cursor()
        _bl_init(cur)
        row = cur.execute("SELECT window_start, count FROM buy_limit WHERE user_id=?", (uid,)).fetchone()
        conn.commit()
    finally:
        try: conn.close()
        except Exception: pass
    if not row:
        return 0, 0
    ws, cnt = int(row[0] or 0), int(row[1] or 0)
    if ws <= 0 or now - ws >= BUYLIMIT_WINDOW:
        return 0, 0
    return cnt, BUYLIMIT_WINDOW - (now - ws)

def _bl_fmt_left(secs):
    secs = max(0, int(secs))
    return f"{secs // 60} মিনিট {secs % 60} সেকেন্ড"

def _bl_allow(uid, qty=1, cat=None):
    """(ok, used, left_secs) — limit ছাড়ালে ok=False; non-limited category হলে সবসময় ok"""
    if not _bl_limited(cat):
        return True, 0, 0
    used, left = _bl_state(uid)
    try: qty = max(1, int(qty))
    except Exception: qty = 1
    if used + qty > BUYLIMIT_MAX:
        if left <= 0:
            left = BUYLIMIT_WINDOW
        return False, used, left
    return True, used, left

def _bl_commit(uid, qty=1, cat=None):
    """কেনার পরে count বাড়ায়; ফেরত দেয় (used, left_secs)"""
    if not _bl_limited(cat):
        return 0, 0
    import time as _t
    now = int(_t.time())
    try: qty = max(1, int(qty))
    except Exception: qty = 1
    conn = _bl_conn()
    try:
        cur = conn.cursor()
        _bl_init(cur)
        row = cur.execute("SELECT window_start, count FROM buy_limit WHERE user_id=?", (uid,)).fetchone()
        if row and int(row[0] or 0) > 0 and now - int(row[0]) < BUYLIMIT_WINDOW:
            ws, cnt = int(row[0]), int(row[1] or 0) + qty
            cur.execute("UPDATE buy_limit SET count=? WHERE user_id=?", (cnt, uid))
        else:
            ws, cnt = now, qty
            cur.execute(
                "INSERT INTO buy_limit (user_id, window_start, count) VALUES (?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET window_start=excluded.window_start, count=excluded.count",
                (uid, ws, cnt))
        conn.commit()
    finally:
        try: conn.close()
        except Exception: pass
    return cnt, max(0, BUYLIMIT_WINDOW - (now - ws))

def _bl_block_text(used, left):
    return (
        "⛔ **কেনার লিমিট শেষ**\\n\\n"
        f"🧾 আপনি এই ১০ মিনিটে **{used}/{BUYLIMIT_MAX} pcs** নিয়ে ফেলেছেন।\\n"
        f"⏳ আবার নিতে পারবেন: **{_bl_fmt_left(left)}** পরে\\n\\n"
        f"ℹ️ নিয়ম: প্রতি **১০ মিনিটে সর্বোচ্চ {BUYLIMIT_MAX} pcs**। "
        "সময় শেষ হলেই আবার পুরো লিমিট চালু হবে।"
    )

def _bl_ok_text(used, left):
    return (
        f"⏱ **লিমিট আপডেট:** এই উইন্ডোতে **{used}/{BUYLIMIT_MAX} pcs** ব্যবহার হয়েছে "
        f"(বাকি **{max(0, BUYLIMIT_MAX - used)} pcs**)\\n"
        f"🔄 নতুন ১০ pcs লিমিট চালু হবে **{_bl_fmt_left(left)}** পরে"
    )
# [BUYLIMIT_V1] ---- end helper ----
'''


def die(m):
    print(f"\n❌ {m}\n")
    sys.exit(1)


def inspect(src):
    lines = src.splitlines()
    pats = [
        ("balance deduct", re.compile(r"UPDATE\s+users\s+SET\s+balance\s*=\s*balance\s*-")),
        ("sales insert",   re.compile(r"INSERT\s+INTO\s+sales")),
        ("stock delete",   re.compile(r"DELETE\s+FROM\s+stock")),
        ("qty handler",    re.compile(r"(async\s+def\s+\w*(buy|qty|quantity|purchase)\w*)", re.I)),
    ]
    for label, rx in pats:
        print(f"\n===== {label} =====")
        for i, ln in enumerate(lines, 1):
            if rx.search(ln):
                print(f"{i}: {ln.strip()[:160]}")
    print("\n👉 উপরের আউটপুট পাঠালে আমি exact hook বসিয়ে দিচ্ছি।")


def main():
    if not os.path.exists(STORE_PY):
        die(f"{STORE_PY} এই folder এ নাই। `cd /root` করে চালান।")
    src = open(STORE_PY, encoding="utf-8").read()

    if "--inspect" in sys.argv:
        inspect(src)
        return

    if MARKER in src:
        print("ℹ️ helper আগেই আছে — শুধু hook যাচাই করছি।")
    else:
        # helper insert: শেষ top-level import এর পরে
        last = 0
        for m in re.finditer(r"^(?:import|from)\s+\S+.*$", src, re.M):
            last = m.end()
        if not last:
            die("import block খুঁজে পাওয়া যায়নি।")
        src = src[:last] + "\n" + HELPER + src[last:]

    # ---- hook: balance deduction line (purchase commit point) ----
    ded = re.compile(
        r"^(?P<ind>[ \t]*)(?P<code>[^\n]*UPDATE\s+users\s+SET\s+balance\s*=\s*balance\s*-[^\n]*)$",
        re.M)
    hits = list(ded.finditer(src))
    if not hits:
        die("balance deduction line পাওয়া যায়নি — `--inspect` চালিয়ে আউটপুট পাঠান।")

    backup = f"{STORE_PY}.backup-buylimit-{int(time.time())}"
    shutil.copy2(STORE_PY, backup)
    print(f"✅ Backup: {backup}")

    open(STORE_PY, "w", encoding="utf-8").write(src)
    try:
        py_compile.compile(STORE_PY, doraise=True)
    except py_compile.PyCompileError as e:
        shutil.copy2(backup, STORE_PY)
        die(f"Syntax error — revert করা হলো: {e}")

    print("✅ BUYLIMIT helper installed (10 pcs / 10 min)")
    print(f"ℹ️ deduction candidate lines: {len(hits)} টি — hook বসাতে `--inspect` আউটপুট দরকার।")
    print("➡️ এরপর: pm2 restart nexus-bot")


if __name__ == "__main__":
    main()
