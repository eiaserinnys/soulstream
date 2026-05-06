"""PostgresEventMixin — 이벤트 CRUD (PostgreSQL)"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg

logger = logging.getLogger(__name__)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _event_to_dict(row: asyncpg.Record) -> dict:
    """asyncpg Record를 이벤트 dict으로 변환한다.

    모듈 수준 함수로 추출되어 search.py 등 다른 mixin에서도 import하여 사용한다.
    """
    d = dict(row)
    if isinstance(d.get("created_at"), datetime):
        d["created_at"] = d["created_at"].isoformat()
    if isinstance(d.get("payload"), (dict, list)):
        d["payload"] = json.dumps(d["payload"], ensure_ascii=False)
    return d


class PostgresEventMixin:
    """이벤트 CRUD (PostgreSQL 구현)

    Mixin이므로 self._pool은 PostgresSessionDB.__init__에서 설정된다.
    """

    _pool: asyncpg.Pool

    async def append_event(
        self,
        session_id: str,
        event_type: str,
        payload: str,
        searchable_text: str,
        created_at: str,
    ) -> int:
        """이벤트를 원자적으로 저장하고 할당된 event_id를 반환한다."""
        # created_at이 ISO 문자열이면 timestamptz로 변환
        if isinstance(created_at, str):
            try:
                created_at = datetime.fromisoformat(created_at)
            except ValueError:
                created_at = _utc_now()

        event_id = await self._pool.fetchval(
            "SELECT event_append($1, $2, $3, $4, $5)",
            session_id, event_type, payload, searchable_text, created_at,
        )
        return event_id

    async def read_events(
        self, session_id: str, after_id: int = 0,
        limit: int | None = None, event_types: list[str] | None = None,
    ) -> list[dict]:
        rows = await self._pool.fetch(
            "SELECT * FROM event_read($1, $2, $3, $4)",
            session_id, after_id, limit, event_types,
        )
        return [_event_to_dict(r) for r in rows]

    async def stream_events_raw(
        self, session_id: str, after_id: int = 0,
    ) -> AsyncGenerator[tuple[int, str, str], None]:
        """이벤트를 (id, event_type, payload_text) 튜플로 스트리밍."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                async for row in conn.cursor(
                    "SELECT * FROM event_stream_raw($1, $2)",
                    session_id, after_id,
                ):
                    yield row["id"], row["event_type"], row["payload_text"]

    async def read_one_event(self, session_id: str, event_id: int) -> Optional[dict]:
        row = await self._pool.fetchrow(
            "SELECT * FROM event_read_one($1, $2)",
            session_id, event_id,
        )
        return _event_to_dict(row) if row else None

    async def read_last_event_of_type(
        self, session_id: str, event_type: str,
    ) -> Optional[dict]:
        """세션의 특정 type 마지막 이벤트 1건을 반환. 없으면 None.

        prompt_suggestion 같은 turn-meta 이벤트의 새로고침 baseline 복원에 사용.
        """
        row = await self._pool.fetchrow(
            """
            SELECT * FROM events
            WHERE session_id = $1 AND event_type = $2
            ORDER BY id DESC
            LIMIT 1
            """,
            session_id, event_type,
        )
        return _event_to_dict(row) if row else None

    async def count_events(self, session_id: str) -> int:
        return await self._pool.fetchval(
            "SELECT event_count($1)", session_id
        )

    async def read_last_event_id(self, session_id: str) -> int:
        val = await self._pool.fetchval(
            "SELECT COALESCE(MAX(id), 0) FROM events WHERE session_id = $1",
            session_id,
        )
        return val or 0
