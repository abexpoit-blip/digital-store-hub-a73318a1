#!/usr/bin/env python3
"""V7: the V6 upload helper used time.time() but `time` was not imported in
store.py's module scope -> NameError on every upload. Import it locally."""
import shutil, sys, time as _t

path = "/root/store.py"
src = open(path, encoding="utf-8").read()

if "# [DELIVERY_UPLOAD_FIX_V6]" not in src:
    print("❌ V6 block not found. Run apply-delivery-upload-v6.py first."); sys.exit(2)

changed = 0
if "import time as _dtime" not in src:
    src = src.replace(
        "import urllib.request as _durllib\n",
        "import urllib.request as _durllib\nimport time as _dtime\n", 1)
    changed += 1

old = '_boundary = "----nx" + str(int(time.time() * 1000))'
new = '_boundary = "----nx" + str(int(_dtime.time() * 1000))'
if old in src:
    src = src.replace(old, new)
    changed += 1

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
print("✅ V7 applied: upload helper now uses _dtime (file upload unblocked)")
