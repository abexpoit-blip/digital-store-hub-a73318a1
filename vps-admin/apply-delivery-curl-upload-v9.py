#!/usr/bin/env python3
"""V9: upload Telegram delivery files with curl in a killable subprocess.

Python HTTPS/socket uploads can remain blocked after asyncio.wait_for expires
because cancelling to_thread does not stop its worker. curl gets both network
timeouts and a parent-enforced subprocess timeout, so delivery always either
finishes or reaches the existing text fallback within about one minute.
"""
import shutil
import sys
import time

path = "/root/store.py"
src = open(path, encoding="utf-8").read()

if "# [DELIVERY_UPLOAD_FIX_V6]" not in src:
    print("❌ Delivery V6+ block not found. Run apply-delivery-upload-v6.py first.")
    sys.exit(2)

start = src.find("def _dsend_document_sync(chat_id, filename, payload, caption):")
end = src.find("\n\nasync def _dstep", start)
if start < 0 or end < 0:
    print("❌ Upload helper boundaries not found; unchanged.")
    sys.exit(3)

helper = '''def _dsend_document_sync(chat_id, filename, payload, caption):
    import json as _json_upload
    import os as _os_upload
    import re as _re_upload
    import subprocess as _subprocess_upload
    import tempfile as _tempfile_upload

    # Keep the Telegram token out of the process argument list. curl receives
    # the URL through stdin config instead, and all output is captured.
    _safe_name = _re_upload.sub(r"[^A-Za-z0-9._-]", "_", str(filename)) or "delivery.txt"
    _tmp_path = None
    try:
        with _tempfile_upload.NamedTemporaryFile(
                mode="wb", prefix="nx-delivery-", suffix="-" + _safe_name,
                dir="/tmp", delete=False) as _tmp:
            _tmp.write(payload)
            _tmp_path = _tmp.name

        _cmd = [
            "curl", "--ipv4", "--silent", "--show-error", "--fail-with-body",
            "--connect-timeout", "10", "--max-time", "45",
            "--request", "POST",
            "--form-string", f"chat_id={chat_id}",
            "--form-string", f"caption={caption or ''}",
            "--form", f"document=@{_tmp_path};filename={_safe_name}",
            "--config", "-",
        ]
        _config = f'url = "https://api.telegram.org/bot{_dtoken()}/sendDocument"\\n'
        try:
            _done = _subprocess_upload.run(
                _cmd, input=_config, text=True, capture_output=True,
                timeout=50, check=False)
        except _subprocess_upload.TimeoutExpired as _timeout_error:
            raise TimeoutError("curl upload killed after 50s") from _timeout_error

        _raw = (_done.stdout or "").strip()
        if _done.returncode != 0:
            _detail = (_done.stderr or _raw or "curl failed").strip()[:300]
            raise RuntimeError(f"curl exit={_done.returncode}: {_detail}")
        try:
            _result = _json_upload.loads(_raw)
        except Exception as _json_error:
            raise RuntimeError("telegram returned invalid JSON") from _json_error
        if not _result.get("ok"):
            raise RuntimeError(
                f"telegram rejected: {_result.get('description', 'unknown error')}")
        return True
    finally:
        if _tmp_path:
            try:
                _os_upload.unlink(_tmp_path)
            except FileNotFoundError:
                pass
'''

patched = src[:start] + helper + src[end:]

# One bounded upload is enough. A second attempt delayed fallback for another
# two minutes and could leave another unkillable worker on older patches.
patched = patched.replace("for _try in (1, 2):", "for _try in (1,):", 1)
patched = patched.replace(
    "_dsend_document_sync, _chat, _name, _bytes, _caption), 120)",
    "_dsend_document_sync, _chat, _name, _bytes, _caption), 55)",
    1,
)
patched = patched.replace(
    'print("[delivery-v8] callback middleware active (IPv4 direct upload)", flush=True)',
    'print("[delivery-v9] callback middleware active (killable curl IPv4 upload)", flush=True)',
    1,
)
patched = patched.replace(
    'print("[delivery-v6] callback middleware active (direct upload)", flush=True)',
    'print("[delivery-v9] callback middleware active (killable curl IPv4 upload)", flush=True)',
    1,
)
patched = patched.replace(
    'print(f"[delivery-v6] {msg}", flush=True)',
    'print(f"[delivery-v9] {msg}", flush=True)',
    1,
)

if "_subprocess_upload.run" not in patched:
    print("❌ curl helper generation failed; unchanged.")
    sys.exit(4)

try:
    compile(patched, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; unchanged: {exc}")
    sys.exit(5)

if patched == src:
    print("ℹ️ V9 already applied; nothing to change.")
    sys.exit(0)

backup = f"{path}.bak-delivery-v9-{int(time.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(patched)
print(f"✅ Backup: {backup}")
print("✅ V9 applied: killable curl IPv4 upload (50s hard limit, then text fallback)")