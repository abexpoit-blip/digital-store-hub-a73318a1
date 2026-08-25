#!/usr/bin/env python3
"""
=====================================================================
 BUY LIMIT PATCH v2  —  exact hook বসায় (FB 1000xx: 10 pcs / 10 min)
=====================================================================
 কী করে:
   • v1 helper (_bl_allow / _bl_commit / text) store.py-তে বসায়
   • process_buy() এর balance deduction line এর ঠিক আগে guard বসায়
   • কেনার পরে count commit + "কত pcs বাকি / কত সময় বাকি" message
   • category/qty variable নাম INSERT INTO sales থেকে auto-detect করে
   • syntax error হলে নিজে থেকেই backup restore করে

 চালানো (VPS):
   cd /root/digital-store-hub && git pull
   python3 vps-admin/apply-buylimit-v2.py --dump    # শুধু function দেখাবে
   python3 vps-admin/apply-buylimit-v2.py           # patch করবে
   pm2 restart nexus-bot   # অথবা: pm2 restart nexusx-bot

 Revert:
   cp /root/store.py.backup-buylimit2-<ts> /root/store.py && pm2 restart nexus-bot
=====================================================================
"""
import os, re, sys, time, shutil, py_compile, importlib.util, sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
V1 = os.path.join(HERE, "apply-buylimit-v1.py")
MARKER = "# [BUYLIMIT_V1]"
HOOK_MARK = "# [BUYLIMIT_HOOK]"
HELPER_START = "# [BUYLIMIT_V1] ---- 10 pcs / 10 min limit"
HELPER_END = "# [BUYLIMIT_V1] ---- end helper ----"


def _replace_helper(src, helper):
    start = src.find(HELPER_START)
    if start < 0:
        last = 0
        for m2 in re.finditer(r"^(?:import|from)\s+\S+.*$", src, re.M):
            last = m2.end()
        if not last:
            die("import block পাওয়া যায়নি।")
        return src[:last] + "\n" + helper + src[last:]
    end = src.find(HELPER_END, start)
    if end < 0:
        die("পুরনো BUYLIMIT helper block অসম্পূর্ণ — backup restore করে আবার চালান।")
    line_end = src.find("\n", end)
    if line_end < 0:
        line_end = len(src)
    else:
        line_end += 1
    return src[:start] + helper.strip("\n") + "\n" + src[line_end:]


def _detect_db_path(src, store_py):
    candidates = []
    for name in ("DB_FILE", "DB_PATH", "DB"):
        m = re.search(r"^\s*%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.M)
        if m:
            val = os.path.expanduser(m.group(1))
            if os.path.isabs(val):
                candidates.append(val)
            else:
                candidates.append(os.path.join(os.path.dirname(store_py), val))
                candidates.append(os.path.abspath(val))
    candidates.extend([
        "/root/store.db",
        os.path.join(os.path.dirname(store_py), "store.db"),
        os.path.abspath("store.db"),
    ])
    seen = set()
    for path in candidates:
        path = os.path.abspath(path)
        if path in seen:
            continue
        seen.add(path)
        if os.path.exists(path):
            return path
    return "/root/store.db"


def _ensure_db_table(src, store_py):
    db_path = _detect_db_path(src, store_py)
    conn = sqlite3.connect(db_path, timeout=15)
    try:
        conn.execute("PRAGMA busy_timeout=15000")
        conn.execute("""CREATE TABLE IF NOT EXISTS buy_limit (
            user_id INTEGER PRIMARY KEY,
            window_start INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0)""")
        conn.execute("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('buylimit_enabled','on')")
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('buylimit_max','10')")
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('buylimit_window_min','10')")
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('buylimit_cats','fb1000, fb1000xx, 1000xx')")
        conn.commit()
    finally:
        conn.close()
    print(f"✅ DB table ready: {db_path} -> buy_limit (+config defaults)")


def die(m):
    print(f"\n❌ {m}\n")
    sys.exit(1)


def load_v1():
    spec = importlib.util.spec_from_file_location("bl_v1", V1)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def find_func(src, name):
    m = re.search(r"^([ \t]*)async def %s\s*\(" % re.escape(name), src, re.M)
    if not m:
        return None
    start = m.start()
    indent = len(m.group(1))
    lines = src[start:].splitlines(keepends=True)
    end = start + len(lines[0])
    for ln in lines[1:]:
        stripped = ln.strip()
        if stripped and not ln.startswith(" " * (indent + 1)) and not ln.startswith("\t"):
            if not stripped.startswith("#"):
                break
        end += len(ln)
    return start, end


def detect_names(body):
    """INSERT INTO sales (...) VALUES (...) এর params tuple থেকে category/qty নাম"""
    m = re.search(r"INSERT\s+INTO\s+sales[^\)]*\)\s*VALUES[^\)]*\)\s*\"?\s*,\s*\(([^\)]*)\)", body, re.S | re.I)
    cat = qty = None
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        if len(parts) >= 4:
            cat, qty = parts[2], parts[3]
    if not cat:
        for cand in ("cat", "category", "sel_cat", "chosen_cat"):
            if re.search(r"\b%s\b" % cand, body):
                cat = cand
                break
    if not qty:
        for cand in ("qty", "quantity", "n", "count"):
            if re.search(r"\b%s\b" % cand, body):
                qty = cand
                break
    return cat, qty


def main():
    v1 = load_v1()
    store_py = v1._resolve_store_py()
    if not store_py:
        die("store.py পাওয়া যায়নি। STORE_PY=/root/store.py দিয়ে চালান।")
    print(f"ℹ️ Target store.py: {store_py}")
    src = open(store_py, encoding="utf-8").read()

    span = find_func(src, "process_buy")
    if not span:
        die("process_buy() পাওয়া যায়নি।")
    s, e = span
    body = src[s:e]

    if "--dump" in sys.argv:
        print("\n===== process_buy() =====\n")
        print(body)
        return

    cat, qty = detect_names(body)
    if not (cat and qty):
        die("category/qty variable detect হয়নি — `--dump` আউটপুট পাঠান।")
    print(f"ℹ️ detected: category={cat}  qty={qty}")

    if HOOK_MARK in body:
        print("ℹ️ hook আগেই বসানো আছে — আবার বসাচ্ছি না।")
        new_body = body
    else:
        ded = re.search(
            r"^(?P<ind>[ \t]*)(?P<code>[^\n]*UPDATE\s+users\s+SET\s+balance\s*=\s*balance\s*-[^\n]*)$",
            body, re.M)
        if not ded:
            die("process_buy() এর ভেতরে balance deduction line পাওয়া যায়নি।")
        ind = ded.group("ind")
        clear = "state.clear()" if "state.clear()" in src else "state.finish()"

        guard = (
            f"{ind}{HOOK_MARK} 10 pcs / 10 min (FB 1000xx only)\n"
            f"{ind}_bl_ok, _bl_used, _bl_left, _bl_allowed = _bl_allow(m.from_user.id, {qty}, {cat})\n"
            f"{ind}if not _bl_ok:\n"
            f"{ind}    try:\n"
            f"{ind}        await m.answer(_bl_block_text(_bl_used, _bl_left, {qty}, _bl_allowed), parse_mode=\"Markdown\")\n"
            f"{ind}    except Exception:\n"
            f"{ind}        await m.answer(_bl_block_text(_bl_used, _bl_left, {qty}, _bl_allowed))\n"
            f"{ind}    try:\n"
            f"{ind}        await {clear}\n"
            f"{ind}    except Exception:\n"
            f"{ind}        pass\n"
            f"{ind}    return\n"
        )
        after = (
            f"{ind}{HOOK_MARK} commit\n"
            f"{ind}try:\n"
            f"{ind}    _bl_u, _bl_l = _bl_commit(m.from_user.id, {qty}, {cat})\n"
            f"{ind}    if _bl_l:\n"
            f"{ind}        await m.answer(_bl_ok_text(_bl_u, _bl_l), parse_mode=\"Markdown\")\n"
            f"{ind}except Exception as _e:\n"
            f"{ind}    print(f\"[buylimit] commit skip: {{_e}}\")\n"
        )
        line = ded.group(0)
        new_body = body[:ded.start()] + guard + line + "\n" + after + body[ded.end() + 1:]

    src2 = src[:s] + new_body + src[e:]

    src2 = _replace_helper(src2, v1.HELPER)

    backup = f"{store_py}.backup-buylimit2-{int(time.time())}"
    shutil.copy2(store_py, backup)
    print(f"✅ Backup: {backup}")
    open(store_py, "w", encoding="utf-8").write(src2)
    try:
        py_compile.compile(store_py, doraise=True)
    except py_compile.PyCompileError as ex:
        shutil.copy2(backup, store_py)
        die(f"Syntax error — revert করা হলো: {ex}")

    _ensure_db_table(src2, store_py)
    print("✅ BUYLIMIT v2 hook installed/upgraded (FB 1000xx: 10 pcs / 10 min, fb61+tempid unlimited)")
    print("➡️ এরপর: pm2 restart nexus-bot")


if __name__ == "__main__":
    main()
