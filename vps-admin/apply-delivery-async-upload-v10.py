#!/usr/bin/env python3
"""V10: send delivery files through a real async curl subprocess (no thread pool).

Why the file still never arrived on V7-V9:

1. Every hung upload attempt from V7/V8 left a *blocked* worker inside the
   default asyncio thread pool. That pool is tiny on a small VPS
   (min(32, cpu+4) -> often 5 workers), so once a few uploads were stuck,
   `asyncio.to_thread(...)` never even started running - which is exactly the
   symptom: `step:upload1 start` and then absolute silence, no FAIL, no
   TIMEOUT, because `wait_for` was cancelled while the job still sat in the
   queue (and on some paths the log line came before the await).
2. Cancelling `to_thread` never kills the worker, so the pool only degrades.

V10 removes threads from the upload path entirely:
  * `asyncio.create_subprocess_exec` runs curl -> cancellable, killable.
  * two attempts: plain HTTP/1.1, then `--no-keepalive --tlsv1.2` (works
    around broken middleboxes/MTU black-holing on POST bodies).
  * curl stderr/stdout is logged, so any remaining failure is visible.
  * text fallback stays intact, so customers never lose their data.
"""
import re
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

helper = '''async def _dsend_document_async(chat_id, filename, payload, caption):
    import asyncio as _aio_upload
    import json as _json_upload
    import os as _os_upload
    import re as _re_upload
    import tempfile as _tempfile_upload

    _safe_name = _re_upload.sub(r"[^A-Za-z0-9._-]", "_", str(filename)) or "delivery.txt"
    _tmp_path = None
    _last = "no attempt"
    try:
        with _tempfile_upload.NamedTemporaryFile(
                mode="wb", prefix="nx-delivery-", suffix="-" + _safe_name,
                dir="/tmp", delete=False) as _tmp:
            _tmp.write(payload)
            _tmp_path = _tmp.name

        _url = f"https://api.telegram.org/bot{_dtoken()}/sendDocument"
        _variants = (
            ["--http1.1"],
            ["--http1.1", "--no-keepalive", "--tlsv1.2", "--expect100-timeout", "1"],
        )
        for _idx, _extra in enumerate(_variants, start=1):
            _cmd = [
                "curl", "--ipv4", "--silent", "--show-error", "--fail-with-body",
                "--connect-timeout", "10", "--max-time", "40",
                *_extra,
                "--request", "POST",
                "--form-string", f"chat_id={chat_id}",
                "--form-string", f"caption={caption or ''}",
                "--form", f"document=@{_tmp_path};filename={_safe_name}",
                _url,
            ]
            _proc = None
            try:
                _proc = await _aio_upload.create_subprocess_exec(
                    *_cmd,
                    stdout=_aio_upload.subprocess.PIPE,
                    stderr=_aio_upload.subprocess.PIPE,
                )
                _out, _err = await _aio_upload.wait_for(_proc.communicate(), 45)
            except _aio_upload.TimeoutError:
                _last = f"attempt{_idx} killed after 45s"
                if _proc is not None:
                    try:
                        _proc.kill()
                    except ProcessLookupError:
                        pass
                print(f"[delivery-v10] upload {_last}", flush=True)
                continue
            except Exception as _spawn_error:
                _last = f"attempt{_idx} spawn error: {_spawn_error}"
                print(f"[delivery-v10] upload {_last}", flush=True)
                continue

            _raw = (_out or b"").decode("utf-8", "replace").strip()
            _errtxt = (_err or b"").decode("utf-8", "replace").strip()
            if _proc.returncode != 0:
                _last = f"attempt{_idx} curl exit={_proc.returncode}: {(_errtxt or _raw)[:300]}"
                print(f"[delivery-v10] upload {_last}", flush=True)
                continue
            try:
                _result = _json_upload.loads(_raw)
            except Exception:
                _last = f"attempt{_idx} invalid JSON: {_raw[:200]}"
                print(f"[delivery-v10] upload {_last}", flush=True)
                continue
            if not _result.get("ok"):
                _last = f"attempt{_idx} telegram: {_result.get('description', 'unknown')}"
                print(f"[delivery-v10] upload {_last}", flush=True)
                continue
            print(f"[delivery-v10] upload attempt{_idx} ok", flush=True)
            return True
        raise RuntimeError(_last)
    finally:
        if _tmp_path:
            try:
                _os_upload.unlink(_tmp_path)
            except FileNotFoundError:
                pass
'''

patched = src[:start] + helper + src[end:]

# Route the caller through the async helper instead of the thread pool.
call_pattern = re.compile(
    r"asyncio\.wait_for\(\s*asyncio\.to_thread\(\s*_dsend_document_sync,\s*"
    r"([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\),\s*\d+\)"
)
patched, n_calls = call_pattern.subn(
    lambda m: (
        "asyncio.wait_for(_dsend_document_async("
        f"{m.group(1).strip()}, {m.group(2).strip()}, "
        f"{m.group(3).strip()}, {m.group(4).strip()}), 100)"
    ),
    patched,
)
if n_calls == 0:
    print("❌ Upload call site not found; unchanged.")
    sys.exit(4)

for old in (
    'print("[delivery-v9] callback middleware active (killable curl IPv4 upload)", flush=True)',
    'print("[delivery-v8] callback middleware active (IPv4 direct upload)", flush=True)',
    'print("[delivery-v6] callback middleware active (direct upload)", flush=True)',
):
    patched = patched.replace(
        old,
        'print("[delivery-v10] callback middleware active '
        '(async curl upload, no thread pool)", flush=True)',
        1,
    )
for old in (
    'print(f"[delivery-v9] {msg}", flush=True)',
    'print(f"[delivery-v6] {msg}", flush=True)',
):
    patched = patched.replace(old, 'print(f"[delivery-v10] {msg}", flush=True)', 1)

if "_dsend_document_sync" in patched:
    print("⚠️ Old sync uploader still referenced somewhere:")
    for line in patched.splitlines():
        if "_dsend_document_sync" in line:
            print("   ", line.strip()[:160])
    print("❌ Refusing partial patch.")
    sys.exit(5)

try:
    compile(patched, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; unchanged: {exc}")
    sys.exit(6)

if patched == src:
    print("ℹ️ V10 already applied; nothing to change.")
    sys.exit(0)

backup = f"{path}.bak-delivery-v10-{int(time.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(patched)
print(f"✅ Backup: {backup}")
print(f"✅ V10 applied: async curl upload (2 variants), call sites patched={n_calls}")
