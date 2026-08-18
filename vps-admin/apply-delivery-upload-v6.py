#!/usr/bin/env python3
"""V6: aiogram's own multipart upload hangs forever on this VPS (step:upload1 never
returns). Replace the file-send step with a direct HTTPS multipart POST to the
Bot API, executed in a worker thread with a hard socket timeout, then fall back
to text delivery. Keeps all V5 step logging."""
import shutil, sys, time

path = "/root/store.py"
src = open(path, encoding="utf-8").read()

start = src.find("# [DELIVERY_CALLBACK_FIX_V5]")
if start < 0:
    print("❌ V5 block not found. Run apply-delivery-trace-v5.py first."); sys.exit(2)
marker = 'print("[delivery-v5] callback middleware active (traced)", flush=True)'
end = src.find(marker, start)
if end < 0:
    print("❌ V5 end marker not found"); sys.exit(3)
end = src.find("\n", end) + 1

block = '''# [DELIVERY_UPLOAD_FIX_V6]
# aiogram's multipart upload stalls indefinitely on this host, so documents are
# pushed with a plain urllib multipart POST that has a real socket timeout.
import socket as _dsocket
import ssl as _dssl
import urllib.request as _durllib
from aiogram import BaseMiddleware as _DfmtBaseMiddleware


def _dlog(msg):
    print(f"[delivery-v6] {msg}", flush=True)


def _dtoken():
    for _n in ("BOT_TOKEN", "TOKEN", "API_TOKEN", "TG_TOKEN", "BOT_API_TOKEN"):
        _v = globals().get(_n)
        if isinstance(_v, str) and ":" in _v and len(_v) > 20:
            return _v
    _v = getattr(getattr(bot, "token", None), "__str__", lambda: "")()
    if isinstance(_v, str) and ":" in _v:
        return _v
    raise RuntimeError("bot token not found")


def _dsend_document_sync(chat_id, filename, payload, caption):
    _boundary = "----nx" + str(int(time.time() * 1000))
    _crlf = "\\r\\n"
    _parts = []

    def _field(name, value):
        _parts.append(
            f'--{_boundary}{_crlf}Content-Disposition: form-data; name="{name}"{_crlf}{_crlf}{value}{_crlf}'
            .encode("utf-8"))

    _field("chat_id", str(chat_id))
    if caption:
        _field("caption", caption)
    _parts.append(
        f'--{_boundary}{_crlf}Content-Disposition: form-data; name="document"; filename="{filename}"'
        f'{_crlf}Content-Type: application/octet-stream{_crlf}{_crlf}'.encode("utf-8"))
    _parts.append(payload)
    _parts.append(f"{_crlf}--{_boundary}--{_crlf}".encode("utf-8"))
    _body = b"".join(_parts)

    _req = _durllib.Request(
        f"https://api.telegram.org/bot{_dtoken()}/sendDocument",
        data=_body,
        headers={"Content-Type": f"multipart/form-data; boundary={_boundary}",
                 "Content-Length": str(len(_body))},
        method="POST")
    _ctx = _dssl.create_default_context()
    with _durllib.urlopen(_req, timeout=90, context=_ctx) as _resp:
        _raw = _resp.read().decode("utf-8", "replace")
    if '"ok":true' not in _raw.replace(" ", ""):
        raise RuntimeError(f"telegram rejected: {_raw[:200]}")
    return True


async def _dstep(name, coro, timeout=60):
    _dlog(f"step:{name} start")
    try:
        _res = await _asyncio_dl.wait_for(coro, timeout=timeout)
        _dlog(f"step:{name} ok")
        return _res
    except _asyncio_dl.TimeoutError:
        _dlog(f"step:{name} TIMEOUT after {timeout}s")
        raise
    except Exception as _e:
        _dlog(f"step:{name} FAIL {type(_e).__name__}: {_e}")
        raise


class _DfmtDeliveryMiddleware(_DfmtBaseMiddleware):
    async def __call__(self, handler, event, data):
        _cbdata = getattr(event, "data", "") or ""
        if not _cbdata.startswith("dfmt:"):
            return await handler(event, data)
        _dlog(f"click user={event.from_user.id} data={_cbdata}")
        _sid = -1
        try:
            _, _fmt, _sid_s = _cbdata.split(":", 2)
            if _fmt not in ("xlsx", "txt"):
                raise ValueError("bad format")
            _sid = int(_sid_s)
        except Exception:
            try:
                await _dstep("answer-invalid", event.answer("Invalid delivery request", show_alert=True), 20)
            except Exception:
                pass
            return None

        try:
            try:
                await _dstep("ack", event.answer(f"{_fmt.upper()} তৈরি হচ্ছে..."), 20)
            except Exception:
                pass

            _meta = _PENDING_DELIVERY.get(_sid)
            _dlog(f"meta cache={'hit' if _meta else 'miss'} sale={_sid}")
            if not _meta:
                def _v6_load():
                    _cn = sqlite3.connect('/root/store.db', timeout=15)
                    try:
                        _cn.execute("PRAGMA busy_timeout=15000")
                        return _cn.execute(
                            "SELECT stock_id, data, category, user_id FROM delivery_archive "
                            "WHERE sale_id=? ORDER BY id ASC", (_sid,)
                        ).fetchall()
                    finally:
                        _cn.close()
                _rows = await _dstep("db-load", _asyncio_dl.to_thread(_v6_load), 30)
                _dlog(f"db rows={len(_rows)} sale={_sid}")
                if not _rows:
                    await _dstep("answer-nodata",
                                 event.answer("Delivery data পাওয়া যায়নি। Admin কে জানান।", show_alert=True), 20)
                    return None
                _cat = _rows[0][2] or "item"
                _owner = _rows[0][3]
                _lbl = {"fb61": "FB 61", "fb1000": "FB 1000", "tempid": "Temp ID",
                        "ig": "Instagram", "fb": "Facebook", "bmig": "BM IG",
                        "bmfb": "BM FB"}.get(_cat, _cat.upper())
                _meta = {"user_id": _owner, "cat": _cat, "lbl": _lbl,
                         "qty": len(_rows), "items": [(r[0], r[1]) for r in _rows]}

            if _meta.get("user_id") and int(_meta["user_id"]) != int(event.from_user.id):
                await _dstep("answer-owner", event.answer("এটা আপনার order নয়", show_alert=True), 20)
                return None

            _items, _lbl, _qty = _meta["items"], _meta["lbl"], _meta["qty"]
            if _fmt == "xlsx":
                try:
                    _bytes = await _dstep("build-xlsx",
                                          _asyncio_dl.to_thread(_fmt_xlsx_sync, _items, _lbl, _qty), 60)
                    _name = f"order-{_sid}-{_meta['cat']}.xlsx"
                except Exception:
                    _bytes = await _dstep("build-txt-fallback",
                                          _asyncio_dl.to_thread(_fmt_txt_sync, _items, _lbl, _qty), 60)
                    _name = f"order-{_sid}-{_meta['cat']}.txt"
            else:
                _bytes = await _dstep("build-txt",
                                      _asyncio_dl.to_thread(_fmt_txt_sync, _items, _lbl, _qty), 60)
                _name = f"order-{_sid}-{_meta['cat']}.txt"
            _dlog(f"file ready sale={_sid} name={_name} bytes={len(_bytes)}")

            _caption = f"📦 {_lbl} × {_qty} • Order #{_sid}"
            _chat = event.message.chat.id
            _sent = False
            for _try in (1, 2):
                try:
                    await _dstep(f"upload{_try}", _asyncio_dl.to_thread(
                        _dsend_document_sync, _chat, _name, _bytes, _caption), 120)
                    _sent = True
                    break
                except Exception:
                    continue

            if not _sent:
                _dlog(f"upload failed -> text fallback sale={_sid}")
                _txt = _bytes.decode("utf-8", "replace") if _name.endswith(".txt") else \\
                    "\\n".join(f"{_i[0]} | {_i[1]}" for _i in _items)
                _chunks = [_txt[_i:_i + 3500] for _i in range(0, len(_txt), 3500)] or ["(empty)"]
                for _idx, _chunk in enumerate(_chunks, 1):
                    try:
                        await _dstep(f"text{_idx}", event.message.answer(
                            f"{_caption} ({_idx}/{len(_chunks)})\\n\\n<code>{_chunk}</code>",
                            parse_mode="HTML"), 60)
                    except Exception:
                        break
            try:
                await _dstep("clear-kb", event.message.edit_reply_markup(reply_markup=None), 20)
            except Exception:
                pass
            _PENDING_DELIVERY.pop(_sid, None)
            _dlog(f"done sale={_sid} fmt={_fmt} sent_as={'file' if _sent else 'text'}")
        except Exception as _error:
            _dlog(f"error sale={_sid}: {type(_error).__name__}: {_error}")
            try:
                await event.message.answer("File পাঠানো যায়নি। Admin কে জানান।")
            except Exception:
                pass
        return None


dp.callback_query.outer_middleware(_DfmtDeliveryMiddleware())
print("[delivery-v6] callback middleware active (direct upload)", flush=True)
'''

patched = src[:start] + block + src[end:]
try:
    compile(patched, path, "exec")
except SyntaxError as exc:
    print(f"❌ Syntax error; unchanged: {exc}"); sys.exit(4)

backup = f"{path}.bak-delivery-v6-{int(time.time())}"
shutil.copy2(path, backup)
open(path, "w", encoding="utf-8").write(patched)
print(f"✅ Backup: {backup}")
print("✅ V6 installed: direct multipart upload with 90s socket timeout + text fallback")
