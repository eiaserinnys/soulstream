"""PostgresViewportMixin — 뷰포트 API (PostgreSQL)"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg

logger = logging.getLogger(__name__)


class PostgresViewportMixin:
    """뷰포트 API (PostgreSQL 구현)

    Mixin이므로 self._pool은 PostgresSessionDB.__init__에서 설정된다.
    """

    _pool: asyncpg.Pool

    async def update_subtree_heights(
        self,
        session_id: str,
        trigger_event_id: int,
        increment: int = 1,
    ) -> tuple[dict[int, int], int]:
        """trigger_event_id의 모든 조상 이벤트의 subtree_height를 increment만큼 올린다.

        WITH RECURSIVE로 trigger에서 루트까지 조상 체인을 수집한 뒤,
        trigger 자신을 제외한 조상 전부를 일괄 UPDATE한다.

        Returns:
            (deltas, new_total_subtree_height)
            - deltas: {event_id: 증가량} — 조상만 포함 (trigger 제외)
            - new_total_subtree_height: 세션의 루트 subtree_height 합계
        """
        # 조상 체인 UPDATE
        sql = """
        WITH RECURSIVE ancestors AS (
            SELECT session_id, id, parent_event_id
            FROM events
            WHERE session_id = $1 AND id = $2
            UNION ALL
            SELECT e.session_id, e.id, e.parent_event_id
            FROM events e
            JOIN ancestors a
              ON a.parent_event_id = e.id
             AND a.session_id = e.session_id
        )
        UPDATE events
        SET subtree_height = subtree_height + $3
        WHERE (session_id, id) IN (
            SELECT session_id, id FROM ancestors WHERE id != $2
        )
        RETURNING id, subtree_height;
        """
        rows = await self._pool.fetch(sql, session_id, trigger_event_id, increment)
        # 각 조상의 새 subtree_height를 받아, increment가 delta임을 활용
        deltas: dict[int, int] = {int(r["id"]): increment for r in rows}

        # 세션의 루트(parent_event_id IS NULL) subtree_height 합계
        new_total = await self._pool.fetchval(
            """
            SELECT COALESCE(SUM(subtree_height), 0)::BIGINT
            FROM events
            WHERE session_id = $1 AND parent_event_id IS NULL
            """,
            session_id,
        )
        return deltas, int(new_total)

    async def read_viewport(
        self,
        session_id: str,
        y_min: int,
        y_max: int,
    ) -> list[dict]:
        """가상 Y축 범위 [y_min, y_max]와 겹치는 이벤트 목록을 반환한다.

        단일 루트 전제: events 테이블에서 session_id의 parent_event_id IS NULL인
        이벤트는 1개여야 한다. 여러 개이면 경고 로그를 남긴다 (SQL은 정상 동작).

        각 항목: {id, parent_event_id, event_type, depth, y_start, y_end, payload}
        """
        # 단일 루트 전제 검증
        root_count = await self._pool.fetchval(
            """
            SELECT COUNT(*)::int FROM events
            WHERE session_id = $1 AND parent_event_id IS NULL
            """,
            session_id,
        )
        if root_count > 1:
            logger.warning(
                f"read_viewport: session {session_id} has {root_count} root events "
                f"(parent_event_id IS NULL). y_start/y_end may include gaps or misalignment."
            )

        rows = await self._pool.fetch(
            "SELECT * FROM events_viewport($1, $2, $3)",
            session_id, y_min, y_max,
        )
        result = []
        for r in rows:
            d = dict(r)
            # asyncpg JSONB 코덱 미등록 시 문자열로 올 수 있음 → dict로 변환
            if isinstance(d.get("payload"), str):
                try:
                    d["payload"] = json.loads(d["payload"])
                except (json.JSONDecodeError, ValueError):
                    d["payload"] = {}
            elif d.get("payload") is None:
                d["payload"] = {}
            result.append(d)
        return result

    async def read_total_subtree_height(self, session_id: str) -> int:
        """세션의 루트(parent_event_id IS NULL) subtree_height 합계를 반환한다."""
        total = await self._pool.fetchval(
            """
            SELECT COALESCE(SUM(subtree_height), 0)::BIGINT
            FROM events
            WHERE session_id = $1 AND parent_event_id IS NULL
            """,
            session_id,
        )
        return int(total or 0)

    async def read_messages(
        self,
        session_id: str,
        before: Optional[str] = None,
        limit: int = 50,
    ) -> tuple[list[dict], Optional[str]]:
        """메시지성 이벤트를 created_at 기준 역순으로 페이지네이션하여 반환한다.

        페이지 이벤트의 부모 체인(ancestor)을 WITH RECURSIVE로 함께 조회하여
        클라이언트가 한 번의 요청으로 트리를 합류할 수 있게 한다.

        Args:
            session_id: 대상 세션
            before: ISO timestamp 커서. None이면 가장 최근부터.
            limit: 페이지 크기

        Returns:
            (messages, next_cursor)
            - messages: [{id, parent_event_id, event_type, payload, created_at}]
              ancestor가 포함되어 created_at DESC 정렬. 클라이언트가 reverse()하면
              부모→자식 ASC 순서가 보장된다.
            - next_cursor: 다음 페이지의 커서 (없으면 None). 페이지 이벤트 기준이며
              ancestor는 커서 계산에 포함되지 않는다.
        """
        # --- 다중 root 경고 ---
        root_count = await self._pool.fetchval(
            "SELECT COUNT(*)::int FROM events "
            "WHERE session_id = $1 AND parent_event_id IS NULL",
            session_id,
        )
        if root_count is not None and root_count > 1:
            logger.warning(
                "read_messages: session %s has %d root events "
                "(parent_event_id IS NULL)",
                session_id, root_count,
            )

        # --- Step 1: 페이지 이벤트 fetch ---
        if before is not None:
            before_dt = (
                before
                if isinstance(before, datetime)
                else datetime.fromisoformat(before)
            )
            rows = await self._pool.fetch(
                """
                SELECT id, parent_event_id, event_type, payload, created_at
                FROM events
                WHERE session_id = $1 AND created_at < $2
                ORDER BY created_at DESC, id DESC
                LIMIT $3
                """,
                session_id, before_dt, limit + 1,
            )
        else:
            rows = await self._pool.fetch(
                """
                SELECT id, parent_event_id, event_type, payload, created_at
                FROM events
                WHERE session_id = $1
                ORDER BY created_at DESC, id DESC
                LIMIT $2
                """,
                session_id, limit + 1,
            )

        # --- Step 2: 페이지네이션 계산 (ancestor 합산 전) ---
        has_more = len(rows) > limit
        page_rows = list(rows[:limit])

        # next_cursor는 페이지 이벤트 기준만 사용 (ancestor 미포함)
        next_cursor: Optional[str] = None
        if has_more and page_rows:
            last_ts = page_rows[-1]["created_at"]
            next_cursor = (
                last_ts.isoformat() if isinstance(last_ts, datetime) else last_ts
            )

        # --- Step 3: ancestor 보강 ---
        page_ids = {int(r["id"]) for r in page_rows}
        missing_parents = {
            int(r["parent_event_id"])
            for r in page_rows
            if r["parent_event_id"] is not None
            and int(r["parent_event_id"]) not in page_ids
        }

        ancestor_rows: list = []
        if missing_parents:
            ancestor_rows = await self._pool.fetch(
                """
                WITH RECURSIVE ancestors AS (
                    SELECT session_id, id, parent_event_id,
                           event_type, payload, created_at
                    FROM events
                    WHERE session_id = $1 AND id = ANY($2::int[])
                    UNION
                    SELECT e.session_id, e.id, e.parent_event_id,
                           e.event_type, e.payload, e.created_at
                    FROM events e
                    JOIN ancestors a
                      ON a.parent_event_id = e.id
                     AND a.session_id = e.session_id
                    WHERE e.session_id = $1
                )
                SELECT id, parent_event_id, event_type, payload, created_at
                FROM ancestors
                """,
                session_id, list(missing_parents),
            )

            if ancestor_rows:
                logger.debug(
                    "read_messages: ancestor chain for session %s: "
                    "%d missing parents → %d ancestors",
                    session_id, len(missing_parents), len(ancestor_rows),
                )

            # 고아 가지 감지: DB에 부모 행이 없는 데이터 손상
            fetched_ids = {int(ar["id"]) for ar in ancestor_rows}
            orphaned = missing_parents - fetched_ids
            if orphaned:
                logger.warning(
                    "read_messages: session %s has %d orphaned parent refs: %s",
                    session_id, len(orphaned), orphaned,
                )

        # --- Step 4: 합산 + DESC 정렬 ---
        all_rows = list(page_rows)
        seen_ids = set(page_ids)
        for ar in ancestor_rows:
            aid = int(ar["id"])
            if aid not in seen_ids:
                all_rows.append(ar)
                seen_ids.add(aid)

        # created_at DESC, id DESC — 어댑터 reverse() 후 부모→자식 ASC 보장
        all_rows.sort(key=lambda r: (r["created_at"], r["id"]), reverse=True)

        # --- Step 5: 직렬화 ---
        messages = []
        for r in all_rows:
            d = dict(r)
            if isinstance(d.get("created_at"), datetime):
                d["created_at"] = d["created_at"].isoformat()
            if isinstance(d.get("payload"), str):
                try:
                    d["payload"] = json.loads(d["payload"])
                except (json.JSONDecodeError, ValueError):
                    d["payload"] = {}
            elif d.get("payload") is None:
                d["payload"] = {}
            messages.append(d)

        return messages, next_cursor
