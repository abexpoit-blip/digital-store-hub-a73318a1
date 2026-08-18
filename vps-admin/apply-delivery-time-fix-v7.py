#!/usr/bin/env python3
"""V7: make the V6 upload helper self-contained by importing time inside the
function. This avoids NameError regardless of store.py's module imports."""
import shutil, sys, time as _t

path = "/root/store.py"
src = open(path, encoding="utf-8").read()

if "# [DELIVERY_UPLOAD_FIX_V6]" not in src:
    print("❌ V6 block not found. Run apply-delivery-upload-v6.py first."); sys.exit(2)

changed = 0
old_function = "def _dsend_document_sync(chat_id, filename, payload, caption):\n"
new_function = (
    "def _dsend_document_sync(chat_id, filename, payload, caption):\n"
    "    import time as _upload_time\n"
)
if "import time as _upload_time" not in src and old_function in src:
    src = src.replace(old_function, new_function, 1)
    changed += 1

for old in (
    '_boundary = "----nx" + str(int(time.time() * 1000))',
    '_boundary = "----nx" + str(int(_dtime.time() * 1000))',
):
    new = '_boundary = "----nx" + str(int(_upload_time.time() * 1000))'
    if old in src:
        src = src.replace(old, new, 1)
        changed += 1

if '_boundary = "----nx" + str(int(_upload_time.time() * 1000))' not in src:
    print("❌ V6 boundary line not found; unchanged."); sys.exit(3)

if not changed:
    print("ℹ️ Already fixed; nothing to change."); sys.exit(0)

try:
    compile(src, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; unchanged: {exc}"); sys.exit(4)

backup = f"{path}.bak-delivery-v7-{int(_t.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(src)
print(f"✅ Backup: {backup}")
print("✅ V7 applied: upload helper imports time locally (file upload unblocked)")
