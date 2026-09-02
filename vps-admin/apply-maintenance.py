#!/usr/bin/env python3
"""
=====================================================================
 MAINTENANCE MODE PATCH v1  —  web panel থেকে bot ON/OFF
=====================================================================
 কী করে:
   • store.py-তে একটা aiogram middleware বসায় যা config table পড়ে
   • maintenance_mode = on হলে সাধারণ user কে maintenance message দেখায়
     (message + callback দুটোই block হয়), admin রা স্বাভাবিক ব্যবহার করতে পারে
   • config value 5 sec cache — panel এ toggle করলেই সাথে সাথে apply, restart লাগে না
   • config এ default value seed করে (maintenance_mode=off + message)
   • syntax error হলে নিজে থেকেই backup restore করে

 চালানো (VPS):
   cd /root/digital-store-hub && git pull
   python3 vps-admin/apply-maintenance.py
   pm2 restart nexus-bot

 Revert:
   cp /root/store.py.backup-maint-<ts> /root/store.py && pm2 restart nexus-bot
=====================================================================
"""
import os, re, sys, time, shutil, py_compile, sqlite3

MARK_START = "# [MAINTENANCE_V1] ---- web controlled maintenance mode"
MARK_END = "# [MAINTENANCE_V1] ---- end maintenance ----"
HOOK_MARK = "# [MAINTENANCE_HOOK]"

DEFAULT_MSG = (
    "🛠 সিস্টেম আপডেট চলছে\n\n"
    "আমরা কিছু জরুরি কাজ করছি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।\n"
    "আপনার ব্যালান্স ও অর্ডার সম্পূর্ণ নিরাপদ আছে। ধন্যবাদ 🙏"
)

HELPER = '''
# [MAINTENANCE_V1] ---- web controlled maintenance mode ----
import time as _mt_time
import sqlite3 as _mt_sqlite

_MT_CACHE = {"t": 0.0, "on": False, "msg": ""}
_MT_TTL = 5.0
_MT_DEFAULT_MSG = (
    "🛠 সিস্টেম আপডেট চলছে\\n\\n"
    "আমরা কিছু জরুরি কাজ করছি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।\\n"
    "আপনার ব্যালান্স ও অর্ডার সম্পূর্ণ নিরাপদ আছে। ধন্যবাদ 🙏"
)


def _mt_db_path():
    for _name in ("DB_FILE", "DB_PATH", "DB"):
        _v = globals().get(_name)
        if isinstance(_v, str) and _v:
            return _v
    return "__DB_PATH__"


def _mt_state():
    """config table থেকে maintenance state পড়ে (5s cache)।"""
    now = _mt_time.time()
    if now - _MT_CACHE["t"] < _MT_TTL:
        return _MT_CACHE["on"], _MT_CACHE["msg"]
    on, msg = False, _MT_DEFAULT_MSG
    try:
        con = _mt_sqlite.connect(_mt_db_path(), timeout=5)
        cur = con.execute(
            "SELECT key, value FROM config WHERE key IN ('maintenance_mode','maintenance_msg')"
        )
        rows = dict(cur.fetchall())
        con.close()
        on = str(rows.get("maintenance_mode", "off")).strip().lower() in ("1", "on", "true", "yes")
        msg = (rows.get("maintenance_msg") or "").strip() or _MT_DEFAULT_MSG
    except Exception as _e:
        print(f"[maintenance] read skip: {_e}")
    _MT_CACHE.update({"t": now, "on": on, "msg": msg})
    return on, msg


def _mt_is_admin(uid):
    try:
        uid = int(uid)
    except Exception:
        return False
    for _name in ("ADMIN_IDS", "ADMINS", "ADMIN_ID", "OWNER_ID", "ADMIN_LIST"):
        _v = globals().get(_name)
        if _v is None:
            continue
        try:
            if isinstance(_v, (list, tuple, set, frozenset)):
                if uid in {int(x) for x in _v}:
                    return True
            elif isinstance(_v, dict):
                if uid in {int(x) for x in _v.keys()}:
                    return True
            else:
                if uid == int(_v):
                    return True
        except Exception:
            continue
    return False


async def _mt_gate(event, data):
    """True = block করা হয়েছে (handler চালানো যাবে না)।"""
    on, msg = _mt_state()
    if not on:
        return False
    user = getattr(event, "from_user", None)
    uid = getattr(user, "id", None)
    if uid is not None and _mt_is_admin(uid):
        return False
    try:
        if hasattr(event, "answer") and hasattr(event, "data"):  # CallbackQuery
            await event.answer("🛠 Maintenance চলছে — একটু পরে চেষ্টা করুন", show_alert=True)
            try:
                await event.message.answer(msg)
            except Exception:
                pass
        elif hasattr(event, "answer"):  # Message
            await event.answer(msg)
    except Exception as _e:
        print(f"[maintenance] notify fail: {_e}")
    return True
# [MAINTENANCE_V1] ---- end maintenance ----
'''

MIDDLEWARE_BODY = '''
{HOOK}
async def _mt_middleware(handler, event, data):
    try:
        _mt_inner = getattr(event, "event", None) or event
        if await _mt_gate(_mt_inner, data):
            return None
    except Exception as _e:
        print(f"[maintenance] middleware skip: {{_e}}")
    return await handler(event, data)


try:
    {DP}.update.outer_middleware(_mt_middleware)
    print("[maintenance] v1 READY — web panel থেকে ON/OFF করা যাবে")
except Exception as _e:
    print(f"[maintenance] attach fail: {{_e}}")
'''


def die(msg):
    print("❌ " + msg)
    sys.exit(1)


def find_store_py():
    cands = [
        "/root/store.py",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "store.py"),
        os.path.abspath("store.py"),
    ]
    for p in cands:
        p = os.path.abspath(p)
        if os.path.exists(p):
            return p
    die("store.py পাওয়া যায়নি (/root/store.py ?)")


def detect_db_path(src, store_py):
    for name in ("DB_FILE", "DB_PATH", "DB"):
        m = re.search(r"^\s*%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.M)
        if m:
            val = os.path.expanduser(m.group(1))
            if not os.path.isabs(val):
                val = os.path.join(os.path.dirname(store_py), val)
            if os.path.exists(val):
                return os.path.abspath(val)
    for p in ("/root/store.db", os.path.join(os.path.dirname(store_py), "store.db")):
        if os.path.exists(p):
            return os.path.abspath(p)
    return "/root/store.db"


def detect_dp(src):
    m = re.search(r"^\s*(\w+)\s*=\s*Dispatcher\s*\(", src, re.M)
    if m:
        return m.group(1)
    if re.search(r"^\s*dp\b", src, re.M):
        return "dp"
    die("Dispatcher (dp) variable পাওয়া যায়নি — patch করা গেল না।")


def strip_block(src, start_mark, end_mark):
    s = src.find(start_mark)
    if s < 0:
        return src
    e = src.find(end_mark, s)
    if e < 0:
        die("পুরনো MAINTENANCE block অসম্পূর্ণ — backup restore করে আবার চালান।")
    e = src.find("\n", e)
    e = len(src) if e < 0 else e + 1
    return src[:s] + src[e:]


def seed_config(db_path):
    try:
        con = sqlite3.connect(db_path, timeout=10)
        con.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
        con.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('maintenance_mode','off')")
        con.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('maintenance_msg',?)", (DEFAULT_MSG,))
        for key in ("buy_service_enabled", "deposit_service_enabled", "vpn_service_enabled", "replace_service_enabled"):
            con.execute("INSERT OR IGNORE INTO config (key, value) VALUES (?, 'on')", (key,))
        con.commit()
        con.close()
        print(f"✅ config seeded: {db_path}")
    except Exception as e:
        print(f"⚠️ config seed skip: {e}")


def main():
    store_py = find_store_py()
    src = open(store_py, encoding="utf-8").read()
    db_path = detect_db_path(src, store_py)
    dp = detect_dp(src)

    # পুরনো version থাকলে সরিয়ে দাও (idempotent)
    src = strip_block(src, MARK_START, MARK_END)
    src = re.sub(
        r"\n%s\n(?:.|\n)*?print\(f\"\[maintenance\] attach fail: \{_e\}\"\)\n" % re.escape(HOOK_MARK),
        "\n",
        src,
    )

    helper = HELPER.replace("__DB_PATH__", db_path)

    # helper: শেষ import line এর পরে
    last = 0
    for m in re.finditer(r"^(?:import|from)\s+\S+.*$", src, re.M):
        last = m.end()
    if not last:
        die("import block পাওয়া যায়নি।")
    src = src[:last] + "\n" + helper + src[last:]

    # middleware: ফাইলের শেষে (dp তৈরি হওয়ার পরে নিশ্চিতভাবে চলবে)
    mw = MIDDLEWARE_BODY.replace("{HOOK}", HOOK_MARK).replace("{DP}", dp)
    m_main = re.search(r"^if\s+__name__\s*==\s*['\"]__main__['\"]\s*:", src, re.M)
    if m_main:
        src = src[:m_main.start()] + mw.strip("\n") + "\n\n\n" + src[m_main.start():]
    else:
        src = src.rstrip("\n") + "\n\n" + mw.strip("\n") + "\n"

    backup = f"{store_py}.backup-maint-{int(time.time())}"
    shutil.copy2(store_py, backup)
    print(f"✅ Backup: {backup}")
    open(store_py, "w", encoding="utf-8").write(src)
    try:
        py_compile.compile(store_py, doraise=True)
    except py_compile.PyCompileError as ex:
        shutil.copy2(backup, store_py)
        die(f"Syntax error — revert করা হলো: {ex}")

    seed_config(db_path)
    print(f"✅ MAINTENANCE v1 installed (dispatcher={dp}, db={db_path})")
    print("➡️ এরপর: pm2 restart nexus-bot")


if __name__ == "__main__":
    main()
