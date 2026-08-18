#!/usr/bin/env python3
"""Repair dfmt delivery callbacks with an early observer middleware."""
import os
import shutil
import sys
import time

path = os.environ.get("STORE_PY", "/root/store.py")
marker = "# [DELIVERY_CALLBACK_FIX_V4]"
if not os.path.exists(path):
    print(f"❌ {path} not found"); sys.exit(1)
src = open(path, encoding="utf-8").read()
if marker in src:
    print("ℹ️ V4 already applied"); sys.exit(0)
required = ["def _fmt_txt_sync(", "def _fmt_xlsx_sync(", "_PENDING_DELIVERY", "delivery_archive"]
missing = [x for x in required if x not in src]
if missing:
    print("❌ Existing delivery helpers missing:", ", ".join(missing)); sys.exit(2)
pos = src.find("@dp.callback_query")
if pos < 0:
    print("❌ No callback observer found"); sys.exit(3)

block = '''# [DELIVERY_CALLBACK_FIX_V4]
# Outer middleware runs before callback filters, so catch-all handlers cannot swallow dfmt.
from aiogram import BaseMiddleware as _DfmtBaseMiddleware

class _DfmtDeliveryMiddleware(_DfmtBaseMiddleware):
    async def __call__(self, handler, event, data):
        _cbdata = getattr(event, "data", "") or ""
        if not _cbdata.startswith("dfmt:"):
            return await handler(event, data)
        print(f"[delivery-v4] click user={event.from_user.id} data={_cbdata}", flush=True)
        try:
            _, _fmt, _sid_s = _cbdata.split(":", 2)
            if _fmt not in ("xlsx", "txt"):
                raise ValueError("bad format")
            _sid = int(_sid_s)
        except Exception:
            return await event.answer("Invalid delivery request", show_alert=True)

        try:
            _meta = _PENDING_DELIVERY.get(_sid)
            if not _meta:
                def _v4_load():
                    _cn = sqlite3.connect('/root/store.db', timeout=15)
                    try:
                        _cn.execute("PRAGMA busy_timeout=15000")
                        return _cn.execute(
                            "SELECT stock_id, data, category, user_id FROM delivery_archive "
                            "WHERE sale_id=? ORDER BY id ASC", (_sid,)
                        ).fetchall()
                    finally:
                        _cn.close()
                _rows = await _asyncio_dl.to_thread(_v4_load)
                if not _rows:
                    return await event.answer("Delivery data পাওয়া যায়নি। Admin কে জানান।", show_alert=True)
                _cat = _rows[0][2] or "item"
                _owner = _rows[0][3]
                _lbl = {"fb61":"FB 61","fb1000":"FB 1000","tempid":"Temp ID",
                        "ig":"Instagram","fb":"Facebook","bmig":"BM IG","bmfb":"BM FB"}.get(_cat, _cat.upper())
                _meta = {"user_id": _owner, "cat": _cat, "lbl": _lbl,
                         "qty": len(_rows), "items": [(r[0], r[1]) for r in _rows]}
            if _meta.get("user_id") and int(_meta["user_id"]) != int(event.from_user.id):
                return await event.answer("এটা আপনার order নয়", show_alert=True)

            await event.answer(f"{_fmt.upper()} তৈরি হচ্ছে...")
            _items, _lbl, _qty = _meta["items"], _meta["lbl"], _meta["qty"]
            if _fmt == "xlsx":
                try:
                    _bytes = await _asyncio_dl.to_thread(_fmt_xlsx_sync, _items, _lbl, _qty)
                    _name = f"order-{_sid}-{_meta['cat']}.xlsx"
                except Exception as _xlsx_error:
                    print(f"[delivery-v4] xlsx fallback sale={_sid}: {type(_xlsx_error).__name__}", flush=True)
                    _bytes = await _asyncio_dl.to_thread(_fmt_txt_sync, _items, _lbl, _qty)
                    _name = f"order-{_sid}-{_meta['cat']}.txt"
            else:
                _bytes = await _asyncio_dl.to_thread(_fmt_txt_sync, _items, _lbl, _qty)
                _name = f"order-{_sid}-{_meta['cat']}.txt"

            from aiogram.types import BufferedInputFile as _DfmtBufferedInputFile
            await event.message.answer_document(
                _DfmtBufferedInputFile(_bytes, filename=_name),
                caption=f"📦 {_lbl} × {_qty} • Order #{_sid}",
                request_timeout=180,
            )
            try:
                await event.message.edit_reply_markup(reply_markup=None)
            except Exception:
                pass
            _PENDING_DELIVERY.pop(_sid, None)
            print(f"[delivery-v4] sent sale={_sid} fmt={_fmt} bytes={len(_bytes)}", flush=True)
        except Exception as _error:
            print(f"[delivery-v4] error sale={_sid}: {type(_error).__name__}: {_error}", flush=True)
            try:
                await event.message.answer("File পাঠানো যায়নি। আবার চেষ্টা করুন।")
            except Exception:
                pass
        return None

dp.callback_query.outer_middleware(_DfmtDeliveryMiddleware())
print("[delivery-v4] callback middleware active", flush=True)

'''
patched = src[:pos] + block + src[pos:]
try:
    compile(patched, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; unchanged: {exc}"); sys.exit(4)
backup = f"{path}.bak-delivery-v4-{int(time.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(patched)
print(f"✅ Backup: {backup}")
print("✅ Delivery callback middleware installed before all handlers")
print("✅ Archive DB read is async; upload timeout is 180s")
