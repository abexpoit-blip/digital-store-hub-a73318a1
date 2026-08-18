#!/usr/bin/env python3
"""Register the delivery callback before polling and harden file delivery.

This patch intentionally tolerates older/newer archive-loading implementations.
Handler registration and upload timeout fixes are still safe to apply when that
optional optimisation cannot be matched exactly.
"""
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
archive_async = False
if old in block:
    block = block.replace(old, new, 1)
    archive_async = True
elif "_rows = await _asyncio_dl.to_thread(_load_archive)" in block:
    archive_async = True
else:
    # Store.py has evolved across deployments (_dbc(), different quoting, or
    # an already-patched loader). This optimisation is optional; never block
    # the handler-order and upload-timeout fixes because of a text mismatch.
    print("⚠️ Archive loader differs; leaving its existing implementation unchanged")

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

# Telegram file uploads need a longer timeout than ordinary bot replies.
# Bot.send_document consumes request_timeout locally; it is not sent to the
# Telegram API as a form field. Keep this scoped to delivery files so normal
# messages do not wait for several minutes on a broken connection.
upload_needle = "        await c.message.answer_document(\n            BufferedInputFile(data, filename=fname),\n            caption=("
upload_replacement = "        await c.message.answer_document(\n            BufferedInputFile(data, filename=fname),\n            request_timeout=180,\n            caption=("
if upload_needle in block:
    block = block.replace(upload_needle, upload_replacement, 1)
elif "request_timeout=180" not in block:
    print("⚠️ Upload call differs; delivery handler will use its existing timeout")

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
if archive_async:
    print("✅ Archive DB read moved off the bot event loop")
else:
    print("ℹ️ Archive DB loader preserved (version-safe mode)")
if "request_timeout=180" in block:
    print("✅ Delivery file upload timeout set to 180 seconds")
print("✅ [delivery] click/send timing logs enabled")