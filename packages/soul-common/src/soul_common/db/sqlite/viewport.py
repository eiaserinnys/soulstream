"""SqliteViewportMixin — 뷰포트 API 스텁 (SQLite)

SQLite는 뷰포트 API를 지원하지 않는다. 모든 메서드가 NotImplementedError를 발생시킨다.
"""

from __future__ import annotations

from typing import Optional


class SqliteViewportMixin:
    """뷰포트 API 스텁 (SQLite — NotImplementedError)"""

    async def update_subtree_heights(
        self,
        session_id: str,
        trigger_event_id: int,
        increment: int = 1,
    ) -> tuple[dict[int, int], int]:
        """SQLite는 뷰포트 API를 지원하지 않는다. PostgreSQL 전용."""
        raise NotImplementedError(
            "update_subtree_heights is not supported on SQLite. "
            "Viewport API requires PostgreSQL (WITH RECURSIVE + subtree_height backfill)."
        )

    async def read_viewport(
        self,
        session_id: str,
        y_min: int,
        y_max: int,
    ) -> list[dict]:
        """SQLite는 뷰포트 API를 지원하지 않는다. PostgreSQL 전용."""
        raise NotImplementedError(
            "read_viewport is not supported on SQLite. "
            "Viewport API requires PostgreSQL events_viewport() function."
        )

    async def read_total_subtree_height(self, session_id: str) -> int:
        """SQLite는 뷰포트 API를 지원하지 않는다. PostgreSQL 전용."""
        raise NotImplementedError(
            "read_total_subtree_height is not supported on SQLite. "
            "Viewport API requires PostgreSQL."
        )

    async def read_messages(
        self,
        session_id: str,
        before: Optional[str] = None,
        limit: int = 50,
    ) -> tuple[list[dict], Optional[str]]:
        """SQLite는 뷰포트 API를 지원하지 않는다. PostgreSQL 전용."""
        raise NotImplementedError(
            "read_messages is not supported on SQLite. "
            "Viewport API requires PostgreSQL."
        )

    async def read_timeline(
        self,
        session_id: str,
        before: Optional[str] = None,
        limit: int = 50,
    ) -> tuple[list[dict], Optional[str]]:
        """SQLite는 timeline API를 지원하지 않는다. PostgreSQL 전용."""
        raise NotImplementedError(
            "read_timeline is not supported on SQLite. "
            "Timeline API requires PostgreSQL."
        )

    async def read_timeline_trace(
        self,
        session_id: str,
        timeline_id: str,
    ) -> dict | None:
        """SQLite는 timeline trace API를 지원하지 않는다. PostgreSQL 전용."""
        raise NotImplementedError(
            "read_timeline_trace is not supported on SQLite. "
            "Timeline trace API requires PostgreSQL."
        )
