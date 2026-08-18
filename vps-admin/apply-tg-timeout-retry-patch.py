#!/usr/bin/env python3
# =====================================================================
#  Telegram "Request timeout error" fix for /root/store.py
#  - Longer HTTP timeout for Telegram API session
#  - Auto-retry (3x) on network timeout / flood-wait
#  Idempotent: safe to run multiple times.
# =====================================================================
import re, shutil, time, sys, os

PATH = os.environ.get('STORE_PY', '/root/store.py')
MARK = '# === TG_TIMEOUT_RETRY_GUARD_V1 ==='

src = open(PATH, encoding='utf-8').read()
if MARK in src:
    print('✅ already patched — nothing to do')
    sys.exit(0)

bak = f'{PATH}.bak-tgretry-{int(time.time())}'
shutil.copy2(PATH, bak)
print('backup:', bak)

GUARD = f'''
{MARK}
# Telegram API কল network timeout হলে bot থেকে "HTTP Client says - Request timeout error"
# মেসেজ আসে। নিচের গার্ড: বড় timeout + 3 বার auto-retry (exponential-ish backoff)।
import asyncio as _tg_asyncio
try:
    from aiogram import Bot as _TGBot
    from aiogram.client.session.aiohttp import AiohttpSession as _TGSession
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
                    print('[tg-retry] attempt %d failed: %s' % (attempt + 1, e))
                    await _tg_asyncio.sleep(1.5 * (attempt + 1))
            raise last

        _TGBot.__call__ = _nx_bot_call
        _TGBot._nx_retry_patched = True
        print('[tg-retry] Telegram network retry guard active (3x, timeout=55s)')
except Exception as _e:
    print('[tg-retry] guard skip:', _e)
# === END TG_TIMEOUT_RETRY_GUARD_V1 ===
'''

# ---- 1) insert guard after the last top-level import block ----
lines = src.split('\n')
last_imp = 0
for i, ln in enumerate(lines[:400]):
    if re.match(r'^(import |from )\S', ln):
        last_imp = i
lines.insert(last_imp + 1, GUARD)
src = '\n'.join(lines)

# ---- 2) give Bot() a longer-timeout AiohttpSession if none provided ----
def add_session(m):
    inner = m.group(1)
    if 'session=' in inner:
        return m.group(0)
    return 'Bot(%s, session=_TGSession(timeout=60))' % inner

new_src, n = re.subn(r'Bot\(((?:[^()]|\([^()]*\))*?)\)', add_session, src, count=3)
src = new_src

open(PATH, 'w', encoding='utf-8').write(src)
print('✅ patched %s (Bot session timeout updates: %d)' % (PATH, n))
print('👉 এখন restart দিন: pm2 restart nexus-bot')
