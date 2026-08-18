#!/usr/bin/env python3
# =====================================================================
#  FIX V2 — "NameError: name '_TGSession' is not defined" repair
#  1) Bot(...) থেকে session=_TGSession(...) আর্গুমেন্ট সরায় (crash fix)
#  2) Retry guard ঠিকভাবে module-level এ বসায় (timeout হলে 3x retry)
#  3) request_timeout ডিফল্ট 55s — বড় file upload আর টাইমআউট হবে না
#  Idempotent: বারবার চালানো নিরাপদ।
# =====================================================================
import re, shutil, time, os, sys

PATH = os.environ.get('STORE_PY', '/root/store.py')
MARK = '# === TG_TIMEOUT_RETRY_GUARD_V2 ==='
src = open(PATH, encoding='utf-8').read()

bak = f'{PATH}.bak-tgfix2-{int(time.time())}'
shutil.copy2(PATH, bak)
print('backup:', bak)

# ---- 1) crash-causing session arg remove ----
before = src
src = re.sub(r',\s*session\s*=\s*_TGSession\([^)]*\)', '', src)
print('session-arg removed:', before != src)

# ---- 2) old broken V1 guard remove ----
src = re.sub(
    r'\n# === TG_TIMEOUT_RETRY_GUARD_V1 ===.*?# === END TG_TIMEOUT_RETRY_GUARD_V1 ===\n',
    '\n', src, flags=re.S)

if MARK not in src:
    GUARD = f'''
{MARK}
import asyncio as _tg_asyncio
from aiogram import Bot as _TGBot
from aiogram.exceptions import TelegramNetworkError as _TGNetErr, TelegramRetryAfter as _TGRetryAfter

if not getattr(_TGBot, '_nx_retry_patched', False):
    _tg_orig_call = _TGBot.__call__

    async def _nx_bot_call(self, method, request_timeout=None):
        last = None
        for attempt in range(3):
            try:
                return await _tg_orig_call(self, method, request_timeout=request_timeout or 55)
            except _TGRetryAfter as e:
                last = e
                await _tg_asyncio.sleep(getattr(e, 'retry_after', 2) + 1)
            except (_TGNetErr, _tg_asyncio.TimeoutError) as e:
                last = e
                print('[tg-retry] attempt %d failed: %s' % (attempt + 1, e), flush=True)
                await _tg_asyncio.sleep(1.5 * (attempt + 1))
        raise last

    _TGBot.__call__ = _nx_bot_call
    _TGBot._nx_retry_patched = True
    print('[tg-retry] active (3x retry, timeout=55s)', flush=True)
# === END TG_TIMEOUT_RETRY_GUARD_V2 ===
'''
    lines = src.split('\n')
    last_imp = 0
    for i, ln in enumerate(lines[:400]):
        if re.match(r'^(import |from )\S', ln):
            last_imp = i
    lines.insert(last_imp + 1, GUARD)
    src = '\n'.join(lines)
    print('guard inserted ✅')
else:
    print('guard already present ✅')

# ---- 3) syntax check before writing ----
try:
    compile(src, PATH, 'exec')
except SyntaxError as e:
    print('❌ SyntaxError — patch aborted, file unchanged:', e)
    sys.exit(1)

open(PATH, 'w', encoding='utf-8').write(src)
print('✅ patched', PATH)
print('👉 pm2 restart nexus-bot')
