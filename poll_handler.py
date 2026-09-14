"""Telegram poll vote handler — saves votes into store.db for web admin."""
import json, time, sqlite3, os
from aiogram import Dispatcher
from aiogram.types import PollAnswer

DB_PATH = os.environ.get('DB_PATH', '/root/store.db')

def _save_vote(tg_poll_id: str, user_id: int, username: str, option_ids):
    con = sqlite3.connect(DB_PATH, timeout=5)
    try:
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('PRAGMA busy_timeout=5000')
        row = con.execute(
            'SELECT poll_id FROM poll_sent_map WHERE tg_poll_id = ?',
            (tg_poll_id,)
        ).fetchone()
        if not row:
            return  # এই poll আমাদের system-এর না, ignore
        poll_id = row[0]
        con.execute('''
            INSERT INTO poll_votes
                (poll_id, tg_poll_id, user_id, username, option_ids, voted_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tg_poll_id, user_id) DO UPDATE SET
                option_ids = excluded.option_ids,
                voted_at   = excluded.voted_at,
                username   = excluded.username
        ''', (poll_id, tg_poll_id, user_id, username or '',
              json.dumps(list(option_ids)), int(time.time() * 1000)))
        con.commit()
    except Exception as e:
        print(f'[poll_handler] save error: {e}')
    finally:
        con.close()

def register_poll_handlers(dp: Dispatcher):
    @dp.poll_answer()
    async def on_poll_answer(poll_answer: PollAnswer):
        u = poll_answer.user
        uname = u.username or u.first_name or ''
        _save_vote(poll_answer.poll_id, u.id, uname, poll_answer.option_ids)
        print(f'[poll] vote saved: user={u.id} (@{uname}) options={list(poll_answer.option_ids)}')
