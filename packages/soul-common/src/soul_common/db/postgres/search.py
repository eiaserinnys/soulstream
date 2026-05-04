"""PostgresSearchMixin — 경량 세션 목록 + 전문검색 (PostgreSQL)"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg

from soul_common.db.postgres.events import _event_to_dict

logger = logging.getLogger(__name__)


class PostgresSearchMixin:
    """경량 세션 목록 + 전문검색 (PostgreSQL 구현)

    Mixin이므로 self._pool은 PostgresSessionDB.__init__에서 설정된다.
    _event_to_dict는 events.py에서 모듈 수준 함수로 import한다.
    """

    _pool: asyncpg.Pool

    async def list_sessions_summary(
        self,
        search: str | None = None,
        session_type: str | None = None,
        limit: int = 20,
        offset: int = 0,
        folder_id: str | None = None,
        node_id: str | None = None,
    ) -> tuple[list[dict], int]:
        """경량 세션 목록과 total count를 반환한다."""
        rows = await self._pool.fetch(
            "SELECT * FROM session_list_summary($1, $2, $3, $4, $5, $6)",
            search, session_type, limit, offset, folder_id, node_id,
        )
        if not rows:
            return [], 0
        total = rows[0]["total_count"]
        sessions = [
            {k: v for k, v in dict(r).items() if k != "total_count"}
            for r in rows
        ]
        return sessions, total

    # --- 전문검색 (tsvector) ---

    async def search_events(
        self,
        query: str,
        session_ids: Optional[list[str]] = None,
        limit: int = 50,
        event_types: Optional[list[str]] = None,
    ) -> list[dict]:
        if not query.strip():
            return []

        try:
            rows = await self._pool.fetch(
                "SELECT * FROM event_search($1, $2, $3, $4)",
                query, session_ids, limit, event_types,
            )
            return [_event_to_dict(r) for r in rows]
        except Exception as e:
            logger.warning(f"tsvector search failed: {e}")
            return []

    async def search_events_by_session_id(
        self,
        session_id_query: str,
        event_types: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        """session_id ILIKE 매칭으로 이벤트를 검색한다."""
        if not session_id_query.strip():
            return []
        try:
            rows = await self._pool.fetch(
                "SELECT * FROM session_id_search($1, $2, $3)",
                session_id_query, event_types, limit,
            )
            return [_event_to_dict(r) for r in rows]
        except Exception as e:
            logger.warning(f"session_id_search failed: {e}")
            return []
