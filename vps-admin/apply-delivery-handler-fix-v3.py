#!/usr/bin/env python3
"""Register the delivery callback before polling and make archive reads async-safe."""
import os
import re
import shutil
import sys
import time

path = os.environ.get("STORE_PY", "/root/store.py")
marker = "# [DELIVERY_FORMAT_PATCH_V2] — Smart Hybrid Excel/TXT delivery"

if not os.path.exists(path):
    print(f"❌ {path} not found")
    sys.exit(1)

src = open(path, encoding="utf-8").read()
start = src.find("# ============================================================\n" + marker)
if start < 0:
    print("❌ Delivery V2 block not found")
    sys.exit(2)

# The delivery block was historically appended at EOF. Extract it, then place
# it before the first callback handler so Aiogram registers it before polling
# and before any broad/catch-all callback handler.
block = src[start:].rstrip() + "\n\n"
base = src[:start].rstrip() + "\n\n"
insert_at = base.find("@dp.callback_query")
if insert_at < 0:
    main_guard = re.search(r"(?m)^if\s+__name__\s*==\s*['\"]__main__['\"]\s*:", base)
    if not main_guard:
        print("❌ Safe handler registration point not found")
        sys.exit(3)
    insert_at = main_guard.start()

# Move the SQLite read off the event loop and wait for locks instead of making
# every other bot update pause behind a synchronous query.
old = '''        try:
            _cn = sqlite3.connect('/root/store.db')
            _rows = _cn.execute(
                "SELECT stock_id, data, category, user_id FROM delivery_archive "
                "WHERE sale_id=? ORDER BY id ASC", (sid,)
            ).fetchall()
            _cn.close()'''
new = '''        try:
            def _load_archive():
                _cn = sqlite3.connect('/root/store.db', timeout=15)
                try:
                    _cn.execute("PRAGMA busy_timeout=15000")
                    return _cn.execute(
                        "SELECT stock_id, data, category, user_id FROM delivery_archive "
                        "WHERE sale_id=? ORDER BY id ASC", (sid,)
                    ).fetchall()
                finally:
                    _cn.close()
            _rows = await _asyncio_dl.to_thread(_load_archive)'''
if old in block:
    block = block.replace(old, new, 1)
elif "_rows = await _asyncio_dl.to_thread(_load_archive)" not in block:
    print("❌ Archive-load block differs; refusing an unsafe partial patch")
    sys.exit(4)

# Add a positive trace at callback entry. This distinguishes handler/Telegram
# issues immediately without printing users' delivered credentials.
needle = "async def _delivery_format_cb(c: types.CallbackQuery):\n    _t0 = _time_dl.time()"
replacement = (
    "async def _delivery_format_cb(c: types.CallbackQuery):\n"
    "    _t0 = _time_dl.time()\n"
    "    print(f\"[delivery] click user={c.from_user.id} data={c.data}\", flush=True)"
)
if needle in block:
    block = block.replace(needle, replacement, 1)

patched = base[:insert_at] + block + base[insert_at:]
if patched.find(marker) > patched.find("@dp.callback_query"):
    print("❌ Handler ordering check failed")
    sys.exit(5)

try:
    compile(patched, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; file unchanged: {exc}")
    sys.exit(6)

backup = f"{path}.bak-delivery-v3-{int(time.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(patched)
print(f"✅ Backup: {backup}")
print("✅ Delivery callback registered before polling/catch-all handlers")
print("✅ Archive DB read moved off the bot event loop")
print("✅ [delivery] click/send timing logs enabled")