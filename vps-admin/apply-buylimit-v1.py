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


def _resolve_store_py():
    """Find store.py even when the script is launched from /root/digital-store-hub."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_dir = os.path.dirname(script_dir)
    candidates = []

    explicit = os.environ.get("STORE_PY") or os.environ.get("STORE_PATH")
    if explicit:
        candidates.append(explicit)

    # Most VPS installs keep the bot at /root/store.py, while this helper lives
    # inside /root/digital-store-hub/vps-admin/.
    candidates.extend([
        os.path.abspath("store.py"),
        os.path.join(repo_dir, "store.py"),
        os.path.join(os.path.dirname(repo_dir), "store.py"),
        "/root/store.py",
    ])

    seen = set()
    for path in candidates:
        if not path:
            continue
        path = os.path.abspath(os.path.expanduser(path))
        if path in seen:
            continue
        seen.add(path)
        if os.path.exists(path):
            return path
    return None

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
    """(ok, used, left_secs, allowed) — per-pcs cumulative counting.
    • qty <= বাকি pcs  -> ok=True, allowed=qty
    • qty > বাকি pcs   -> ok=False, allowed=বাকি pcs (0 হলে পুরো block)
    • non-limited category (fb61/tempid) -> সবসময় ok, allowed=qty
    """
    try: qty = max(1, int(qty))
    except Exception: qty = 1
    if not _bl_limited(cat):
        return True, 0, 0, qty
    used, left = _bl_state(uid)
    remain = max(0, BUYLIMIT_MAX - used)
    if qty <= remain:
        return True, used, left, qty
    return False, used, left, remain

def _bl_commit(uid, qty=1, cat=None):
    """কেনার পরে count বাড়ায় (যত pcs কিনেছে ততই); ফেরত দেয় (used, left_secs)"""
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

def _bl_block_text(used, left, want=None, allowed=0):
    used = max(0, int(used or 0))
    remain = max(0, BUYLIMIT_MAX - used)
    if remain > 0:
        head = (
            "⚠️ **লিমিটের বেশি চাওয়া হয়েছে**\\n\\n"
            f"🧾 এই ১০ মিনিটে ব্যবহার: **{used}/{BUYLIMIT_MAX} pcs**\\n"
            f"✅ এখন সর্বোচ্চ নিতে পারবেন: **{remain} pcs**\\n"
            f"⏳ পুরো লিমিট রিসেট হবে: **{_bl_fmt_left(left)}** পরে\\n\\n"
        )
    else:
        head = (
            "⛔ **কেনার লিমিট শেষ**\\n\\n"
            f"🧾 আপনি এই ১০ মিনিটে **{used}/{BUYLIMIT_MAX} pcs** নিয়ে ফেলেছেন।\\n"
            f"⏳ আবার নিতে পারবেন: **{_bl_fmt_left(left)}** পরে\\n\\n"
        )
    return head + (
        f"ℹ️ নিয়ম: **FB 1000xx** এর জন্য প্রতি **১০ মিনিটে সর্বোচ্চ {BUYLIMIT_MAX} pcs** "
        "(কম কম করে নিলেও যোগ হয়ে হিসাব হবে)। FB 61 ও Temp ID unlimited।"
    )

def _bl_ok_text(used, left):
    used = max(0, int(used or 0))
    remain = max(0, BUYLIMIT_MAX - used)
    if remain <= 0:
        return (
            f"⏱ **লিমিট পূর্ণ:** এই উইন্ডোতে **{used}/{BUYLIMIT_MAX} pcs** শেষ\\n"
            f"🔄 নতুন {BUYLIMIT_MAX} pcs লিমিট চালু হবে **{_bl_fmt_left(left)}** পরে"
        )
    return (
        f"⏱ **লিমিট আপডেট:** এই উইন্ডোতে **{used}/{BUYLIMIT_MAX} pcs** ব্যবহার হয়েছে "
        f"(বাকি **{remain} pcs**)\\n"
        f"🔄 রিসেট হবে **{_bl_fmt_left(left)}** পরে"
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
