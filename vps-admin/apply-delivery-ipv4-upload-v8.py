#!/usr/bin/env python3
"""V8: force the direct Telegram document uploader over IPv4.

The aiogram client was already IPv4-only, but V6's urllib uploader used its own
DNS/socket path and could still hang on broken IPv6. This replaces only the
synchronous upload helper and preserves V6 delivery/fallback behavior.
"""
import shutil
import sys
import time

path = "/root/store.py"
src = open(path, encoding="utf-8").read()

if "# [DELIVERY_UPLOAD_FIX_V6]" not in src:
    print("❌ V6 block not found. Run apply-delivery-upload-v6.py first.")
    sys.exit(2)

start = src.find("def _dsend_document_sync(chat_id, filename, payload, caption):")
end = src.find("\n\nasync def _dstep", start)
if start < 0 or end < 0:
    print("❌ V6 upload helper boundaries not found; unchanged.")
    sys.exit(3)

helper = '''def _dsend_document_sync(chat_id, filename, payload, caption):
    import http.client as _http_client
    import json as _json_upload
    import socket as _socket_upload
    import time as _upload_time

    _host = "api.telegram.org"
    _ipv4_rows = _socket_upload.getaddrinfo(
        _host, 443, family=_socket_upload.AF_INET,
        type=_socket_upload.SOCK_STREAM)
    if not _ipv4_rows:
        raise OSError("Telegram IPv4 address not found")
    _ipv4 = _ipv4_rows[0][4][0]
    _boundary = "----nx" + str(int(_upload_time.time() * 1000))
    _crlf = "\\r\\n"
    _parts = []

    def _field(name, value):
        _parts.append(
            f'--{_boundary}{_crlf}Content-Disposition: form-data; name="{name}"'
            f'{_crlf}{_crlf}{value}{_crlf}'.encode("utf-8"))

    _field("chat_id", str(chat_id))
    if caption:
        _field("caption", caption)
    _parts.append(
        f'--{_boundary}{_crlf}Content-Disposition: form-data; name="document"; '
        f'filename="{filename}"{_crlf}Content-Type: application/octet-stream'
        f'{_crlf}{_crlf}'.encode("utf-8"))
    _parts.append(payload)
    _parts.append(f"{_crlf}--{_boundary}--{_crlf}".encode("utf-8"))
    _body = b"".join(_parts)

    class _IPv4HTTPSConnection(_http_client.HTTPSConnection):
        def connect(self):
            self.sock = _socket_upload.create_connection(
                (_ipv4, self.port), self.timeout)
            if self._tunnel_host:
                self._tunnel()
            self.sock = self._context.wrap_socket(
                self.sock, server_hostname=_host)

    _conn = _IPv4HTTPSConnection(_host, 443, timeout=45,
                                  context=_dssl.create_default_context())
    try:
        _conn.request(
            "POST", f"/bot{_dtoken()}/sendDocument", body=_body,
            headers={
                "Host": _host,
                "Content-Type": f"multipart/form-data; boundary={_boundary}",
                "Content-Length": str(len(_body)),
                "Connection": "close",
            })
        _resp = _conn.getresponse()
        _raw = _resp.read().decode("utf-8", "replace")
    finally:
        _conn.close()
    try:
        _result = _json_upload.loads(_raw)
    except Exception as _json_error:
        raise RuntimeError(
            f"telegram invalid response status={_resp.status}") from _json_error
    if _resp.status != 200 or not _result.get("ok"):
        raise RuntimeError(
            f"telegram rejected status={_resp.status}: {_result.get('description', 'unknown')}")
    return True
'''

patched = src[:start] + helper + src[end:]
if "class _IPv4HTTPSConnection" not in patched:
    print("❌ IPv4 helper generation failed; unchanged.")
    sys.exit(4)

try:
    compile(patched, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; unchanged: {exc}")
    sys.exit(5)

if patched == src:
    print("ℹ️ V8 already applied; nothing to change.")
    sys.exit(0)

backup = f"{path}.bak-delivery-v8-{int(time.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(patched)
print(f"✅ Backup: {backup}")
print("✅ V8 applied: Telegram file upload forced over IPv4 (45s socket timeout)")