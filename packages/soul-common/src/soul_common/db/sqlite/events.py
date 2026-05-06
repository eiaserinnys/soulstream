"""SqliteEventMixin — 이벤트 CRUD (SQLite)"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import aiosqlite

from soul_common.db.sqlite._helpers import _utc_now, _event_to_dict

logger = logging.getLogger(__name__)


class SqliteEventMixin:
    """이벤트 CRUD (SQLite 구현)

    Mixin이므로 self._conn, self._session_locks, self._locks_mutex는
    SqliteSessionDB.__init__에서 설정된다.
    """

    _conn: aiosqlite.Connection
    _session_locks: dict[str, asyncio.Lock]
    _locks_mutex: asyncio.Lock

    async def _get_session_lock(self, session_id: str) -> asyncio.Lock:
        """세션별 Lock을 가져오거나 생성한다."""
        async with self._locks_mutex:
            if session_id not in self._session_locks:
                self._session_locks[session_id] = asyncio.Lock()
            return self._session_locks[session_id]

    async def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: str,
        searchable_text: str,
        created_at: str,
    ) -> int:
        """이벤트를 원자적으로 저장하고 할당된 event_id를 반환한다.

        per-session Lock으로 event_id 채번의 원자성을 보장한다.
        (SQLite는 행 단위 FOR UPDATE를 지원하지 않으므로 asyncio.Lock 사용)
        """
        lock = await self._get_session_lock(session_id)
        async with lock:
            # 다음 event_id 채번 (max + 1, 없으면 1)
            cursor = await self._conn.execute(
                "SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = ?",
                (session_id,),
            )
            event_id = (await cursor.fetchone())[0]

            await self._conn.execute(
                "INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, event_id, event_type, payload, searchable_text, created_at),
            )

            # FTS5 독립 테이블에 색인 추가
            if searchable_text:
                await self._conn.execute(
                    "INSERT INTO events_fts (searchable_text, session_id, event_id)"
                    " VALUES (?, ?, ?)",
                    (searchable_text, session_id, event_id),
                )

            # 세션의 last_event_id 갱신
            await self._conn.execute(
                "UPDATE sessions SET last_event_id = ?, updated_at = ? WHERE session_id = ?",
                (event_id, _utc_now(), session_id),
            )

            await self._conn.commit()
            return event_id

    async def read_events(
        self,
        session_id: str,
        after_id: int = 0,
        limit: int | None = None,
        event_types: list[str] | None = None,
    ) -> list[dict]:
        where = "session_id = ? AND id > ?"
        params: list = [session_id, after_id]

        if event_types:
            placeholders = ", ".join("?" * len(event_types))
            where += f" AND event_type IN ({placeholders})"
            params.extend(event_types)

        sql = f"SELECT * FROM events WHERE {where} ORDER BY id ASC"
        if limit is not None and limit > 0:
            sql += f" LIMIT {int(limit)}"

        cursor = await self._conn.execute(sql, params)
        rows = await cursor.fetchall()
        return [_event_to_dict(r) for r in rows]

    async def stream_events_raw(
        self,
        session_id: str,
        after_id: int = 0,
    ) -> AsyncGenerator[tuple[int, str, str], None]:
        """이벤트를 (id, event_type, payload) 튜플로 스트리밍."""
        cursor = await self._conn.execute(
            "SELECT id, event_type, payload FROM events"
            " WHERE session_id = ? AND id > ? ORDER BY id ASC",
            (session_id, after_id),
        )
        async for row in cursor:
            yield row[0], row[1], row[2]

    async def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]:
        cursor = await self._conn.execute(
            "SELECT * FROM events WHERE session_id = ? AND id = ?",
            (session_id, event_id),
        )
        row = await cursor.fetchone()
        return _event_to_dict(row) if row else None

    async def read_last_event_of_type(
        self, session_id: str, event_type: str,
    ) -> Optional[dict]:
        """세션의 특정 type 마지막 이벤트 1건을 반환. 없으면 None.

        prompt_suggestion 같은 turn-meta 이벤트의 새로고침 baseline 복원에 사용.
        """
        cursor = await self._conn.execute(
            """
            SELECT * FROM events
            WHERE session_id = ? AND event_type = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (session_id, event_type),
        )
        row = await cursor.fetchone()
        return _event_to_dict(row) if row else None

    async def count_events(self, session_id: str) -> int:
        cursor = await self._conn.execute(
            "SELECT COUNT(*) FROM events WHERE session_id = ?", (session_id,)
        )
        return (await cursor.fetchone())[0]

    async def read_last_event_id(self, session_id: str) -> int:
        cursor = await self._conn.execute(
            "SELECT COALESCE(MAX(id), 0) FROM events WHERE session_id = ?",
            (session_id,),
        )
        return (await cursor.fetchone())[0]
