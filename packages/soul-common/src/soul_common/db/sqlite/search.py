"""SqliteSearchMixin — 경량 세션 목록 + 전문검색 (SQLite)"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import aiosqlite

logger = logging.getLogger(__name__)


class SqliteSearchMixin:
    """경량 세션 목록 + 전문검색 (SQLite 구현)

    Mixin이므로 self._conn은 SqliteSessionDB.__init__에서 설정된다.
    read_one_event는 SqliteEventMixin에서 제공된다 (다이아몬드 상속).
    """

    _conn: aiosqlite.Connection

    async def list_sessions_summary(
        self,
        search: str | None = None,
        session_type: str | None = None,
        limit: int = 20,
        offset: int = 0,
        folder_id: str | None = None,
        node_id: str | None = None,
    ) -> tuple[list[dict], int]:
        """경량 세션 목록과 total count를 반환한다.

        search가 주어지면 FTS5로 이벤트 텍스트를 검색하여 매칭 세션만 반환한다.
        """
        if search and search.strip():
            return await self._list_sessions_summary_with_search(
                search, session_type, limit, offset, folder_id, node_id
            )

        clauses = []
        params: list = []
        if session_type:
            clauses.append("session_type = ?")
            params.append(session_type)
        if folder_id:
            clauses.append("folder_id = ?")
            params.append(folder_id)
        if node_id:
            clauses.append("node_id = ?")
            params.append(node_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        count_cursor = await self._conn.execute(
            f"SELECT COUNT(*) FROM sessions{where}", params
        )
        total = (await count_cursor.fetchone())[0]
        if total == 0:
            return [], 0

        summary_cols = (
            "session_id, display_name, session_type, status, folder_id,"
            " node_id, last_message, last_event_id, last_read_event_id,"
            " away_summary, created_at, updated_at"
        )
        data_sql = (
            f"SELECT {summary_cols} FROM sessions{where}"
            f" ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
        cursor = await self._conn.execute(data_sql, params + [limit, offset])
        rows = await cursor.fetchall()

        sessions = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("last_message"), str):
                try:
                    d["last_message"] = json.loads(d["last_message"])
                except (json.JSONDecodeError, TypeError):
                    pass
            sessions.append(d)

        return sessions, total

    async def _list_sessions_summary_with_search(
        self,
        search: str,
        session_type: str | None,
        limit: int,
        offset: int,
        folder_id: str | None,
        node_id: str | None,
    ) -> tuple[list[dict], int]:
        """FTS5 검색 결과로 세션 목록을 반환한다."""
        # FTS5 검색으로 매칭 session_id 목록 조회
        fts_cursor = await self._conn.execute(
            "SELECT DISTINCT session_id FROM events_fts WHERE searchable_text MATCH ?",
            (search,),
        )
        fts_rows = await fts_cursor.fetchall()
        matched_ids = [r[0] for r in fts_rows]
        if not matched_ids:
            return [], 0

        placeholders = ", ".join("?" * len(matched_ids))
        clauses = [f"session_id IN ({placeholders})"]
        params: list = list(matched_ids)

        if session_type:
            clauses.append("session_type = ?")
            params.append(session_type)
        if folder_id:
            clauses.append("folder_id = ?")
            params.append(folder_id)
        if node_id:
            clauses.append("node_id = ?")
            params.append(node_id)

        where = " WHERE " + " AND ".join(clauses)

        count_cursor = await self._conn.execute(
            f"SELECT COUNT(*) FROM sessions{where}", params
        )
        total = (await count_cursor.fetchone())[0]
        if total == 0:
            return [], 0

        summary_cols = (
            "session_id, display_name, session_type, status, folder_id,"
            " node_id, last_message, last_event_id, last_read_event_id,"
            " away_summary, created_at, updated_at"
        )
        data_sql = (
            f"SELECT {summary_cols} FROM sessions{where}"
            f" ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        )
        cursor = await self._conn.execute(data_sql, params + [limit, offset])
        rows = await cursor.fetchall()

        sessions = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("last_message"), str):
                try:
                    d["last_message"] = json.loads(d["last_message"])
                except (json.JSONDecodeError, TypeError):
                    pass
            sessions.append(d)

        return sessions, total

    # --- 전문검색 (FTS5) ---

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
            if session_ids is not None:
                if not session_ids:
                    return []
                placeholders = ", ".join("?" * len(session_ids))
                cursor = await self._conn.execute(
                    f"SELECT session_id, event_id FROM events_fts"
                    f" WHERE searchable_text MATCH ? AND session_id IN ({placeholders})"
                    f" LIMIT ?",
                    [query] + list(session_ids) + [limit],
                )
            else:
                cursor = await self._conn.execute(
                    "SELECT session_id, event_id FROM events_fts"
                    " WHERE searchable_text MATCH ? LIMIT ?",
                    (query, limit),
                )

            fts_rows = await cursor.fetchall()
            if not fts_rows:
                return []

            # 이벤트 역참조
            results = []
            for r in fts_rows:
                sid, eid = r[0], r[1]
                event = await self.read_one_event(sid, eid)
                if event:
                    results.append(event)

            # event_types 후처리 필터
            if event_types is not None:
                results = [r for r in results if r.get("event_type") in event_types]
            return results

        except Exception as e:
            logger.warning("FTS5 search failed: %s", e)
            return []

    async def search_events_by_session_id(
        self,
        session_id_query: str,
        event_types: Optional[list[str]] = None,
        limit: int = 50,
    ) -> list[dict]:
        """session_id LIKE 매칭으로 이벤트를 검색한다 (SQLite 테스트용)."""
        if not session_id_query.strip():
            return []
        try:
            cursor = await self._conn.execute(
                "SELECT session_id, id AS event_id FROM events"
                " WHERE session_id LIKE ? LIMIT ?",
                (f"%{session_id_query}%", limit),
            )
            rows = await cursor.fetchall()
            results = []
            for r in rows:
                event = await self.read_one_event(r[0], r[1])
                if event:
                    results.append(event)
            if event_types is not None:
                results = [r for r in results if r.get("event_type") in event_types]
            return results
        except Exception as e:
            logger.warning("session_id_search failed: %s", e)
            return []
