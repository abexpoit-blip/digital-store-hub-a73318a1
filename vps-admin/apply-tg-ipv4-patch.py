#!/usr/bin/env python3
"""
Force IPv4 for all aiohttp (Telegram API) connections in /root/store.py.

Why: VPS resolves api.telegram.org to both IPv4 and IPv6. aiohttp prefers IPv6,
and the IPv6 path to Telegram is half-broken here -> ServerDisconnectedError on
every getUpdates / sendDocument, which makes the bot look unresponsive and file
delivery fail.

Safe: idempotent, makes a timestamped backup, and only inserts a guarded block.
"""
import re
import shutil
import time
from pathlib import Path

STORE = Path("/root/store.py")
MARKER = "[tg-ipv4-patch]"

BLOCK = '''
# === [tg-ipv4-patch] force IPv4 for Telegram API (fixes ServerDisconnectedError) ===
try:
    import socket as _sock_v4
    import aiohttp as _aiohttp_v4

    if not getattr(_aiohttp_v4.TCPConnector, "_lovable_ipv4", False):
        _TCP_ORIG_INIT = _aiohttp_v4.TCPConnector.__init__

        def _tcp_ipv4_init(self, *args, **kwargs):
            kwargs.setdefault("family", _sock_v4.AF_INET)      # IPv4 only
            kwargs.setdefault("ttl_dns_cache", 300)
            kwargs.setdefault("limit", 100)
            kwargs.setdefault("enable_cleanup_closed", True)
            kwargs.setdefault("keepalive_timeout", 30)
            return _TCP_ORIG_INIT(self, *args, **kwargs)

        _aiohttp_v4.TCPConnector.__init__ = _tcp_ipv4_init
        _aiohttp_v4.TCPConnector._lovable_ipv4 = True
    print("[tg-ipv4] active (aiohttp forced to IPv4)", flush=True)
except Exception as _e_v4:  # never break the bot because of this patch
    print(f"[tg-ipv4] skipped: {_e_v4}", flush=True)
# === [/tg-ipv4-patch] ===
'''


def find_insert_line(lines):
    """Insert after the import block, before any Bot(...) construction."""
    last_import = 0
    for i, ln in enumerate(lines[:400]):
        if re.match(r"^\s*(import|from)\s+\S+", ln):
            last_import = i + 1
        if re.search(r"\bBot\s*\(", ln) or re.match(r"^\s*bot\s*=", ln):
            return max(last_import, min(i, last_import if last_import else i))
    return last_import or 0


def main():
    if not STORE.exists():
        raise SystemExit(f"not found: {STORE}")

    src = STORE.read_text(encoding="utf-8")
    if MARKER in src:
        print("ℹ️  already patched (tg-ipv4) — nothing to do")
        return

    backup = f"{STORE}.bak-tg-ipv4-{int(time.time())}"
    shutil.copy2(STORE, backup)

    lines = src.splitlines(keepends=True)
    idx = find_insert_line(lines)
    lines.insert(idx, BLOCK)
    out = "".join(lines)

    # syntax gate before writing
    compile(out, str(STORE), "exec")
    STORE.write_text(out, encoding="utf-8")

    print(f"✅ Backup: {backup}")
    print(f"✅ IPv4-only aiohttp patch inserted at line {idx + 1}")
    print("ℹ️  Restart the bot to apply")


if __name__ == "__main__":
    main()
