#!/usr/bin/env python3
"""events 테이블의 parent_event_id/subtree_height를 backfill한다.

실행 전제:
    1. schema.sql의 ALTER TABLE이 이미 적용되어 parent_event_id(INTEGER)와
       subtree_height(INTEGER NOT NULL DEFAULT 1) 컬럼이 존재해야 한다.

실행 절차:
    단계 2) payload->>'parent_event_id' 값을 정본 컬럼 parent_event_id로 이관 (NULLIF 변환).
    단계 3) 세션별로 루트→리프 DFS를 반복(iterative)으로 수행하여 subtree_height를 계산,
            executemany로 일괄 UPDATE.

재귀 DFS 대신 명시적 스택을 사용한다. 일부 세션은 수천 깊이에 달할 수 있어 Python
기본 recursion limit(1000)를 쉽게 초과하기 때문이다.

Usage:
    TEST_DATABASE_URL=postgresql://... python scripts/backfill_subtree_height.py
    DATABASE_URL=postgresql://... python scripts/backfill_subtree_height.py
    python scripts/backfill_subtree_height.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from typing import Iterable

import asyncpg

logger = logging.getLogger("backfill_subtree_height")


async def migrate_parent_column(conn: asyncpg.Connection) -> int:
    """단계 2: payload.parent_event_id 문자열 값을 정본 INTEGER 컬럼으로 이관한다.

    INTEGER 범위(1..2147483647) 안에 있는 정수 문자열이고, 같은 session_id에 해당
    id의 이벤트 행이 실제로 존재하는 경우에만 캐스트한다. 다음 케이스는 모두 NULL:
      - 비정수 문자열 (tool_use_id 'toolu_...', UUID 등 — 의미가 다른 레거시 키)
      - INT 범위를 초과하는 정수 (timestamp 등 잘못 들어간 값)
      - 부모 이벤트 행이 사라진 dangling 정수 (events_parent_fk 위반 회피)
    정본 컬럼에 이미 값이 있으면 덮어쓰지 않는다.

    Returns:
        변환에 성공한 행 수.
    """
    result = await conn.execute(
        r"""
        UPDATE events e
        SET parent_event_id = (e.payload->>'parent_event_id')::integer
        WHERE e.parent_event_id IS NULL
          AND e.payload->>'parent_event_id' ~ '^\d{1,10}$'
          AND (e.payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647
          AND EXISTS (
            SELECT 1 FROM events p
            WHERE p.session_id = e.session_id
              AND p.id = (e.payload->>'parent_event_id')::INTEGER
          )
        """
    )
    # asyncpg execute는 "UPDATE {n}" 형태의 문자열을 반환한다
    try:
        count = int(result.split()[-1])
    except (ValueError, IndexError):
        count = 0
    return count


async def list_session_ids(conn: asyncpg.Connection) -> list[str]:
    rows = await conn.fetch("SELECT session_id FROM sessions ORDER BY session_id")
    return [r["session_id"] for r in rows]


def compute_heights_iterative(
    rows: Iterable[asyncpg.Record],
) -> dict[int, int]:
    """반복적 DFS로 세션의 모든 이벤트에 대해 subtree_height를 계산한다.

    알고리즘:
        1. children[parent_id] = [child_id, ...] 인접 리스트 구축.
        2. roots(parent_event_id IS NULL)를 시작점으로 각 트리를 개별 순회.
        3. 각 노드에 대해:
           - 첫 진입 시 자식들을 스택에 추가 후 재방문 표시로 다시 푸시한다.
           - 재방문 시 자식들의 height 합 + 1을 자신의 height로 확정한다.

    이 방식은 완전한 post-order 처리를 보장하면서도 재귀 없이 실행된다.

    Returns:
        {event_id: subtree_height} — height ≥ 1, self 포함.
    """
    children: dict[int | None, list[int]] = {}
    for row in rows:
        parent = row["parent_event_id"]
        children.setdefault(parent, []).append(row["id"])

    heights: dict[int, int] = {}
    roots = children.get(None, [])

    # 스택 항목: (node_id, visited)
    # visited=False → 첫 방문: 자식 방문 준비
    # visited=True  → 후위 처리: 자식들 height 합산
    for root in roots:
        stack: list[tuple[int, bool]] = [(root, False)]
        while stack:
            node_id, visited = stack.pop()
            if visited:
                total = 1  # self 포함
                for child in children.get(node_id, []):
                    total += heights[child]
                heights[node_id] = total
            else:
                # 후위 재방문을 먼저 푸시하고, 자식들을 나중에 푸시
                # (LIFO이므로 자식들이 먼저 처리됨)
                stack.append((node_id, True))
                for child in children.get(node_id, []):
                    stack.append((child, False))

    return heights


async def backfill_session(conn: asyncpg.Connection, session_id: str) -> int:
    """세션 하나의 subtree_height를 재계산하여 일괄 UPDATE한다.

    Returns:
        UPDATE된 행 수.
    """
    rows = await conn.fetch(
        "SELECT id, parent_event_id FROM events WHERE session_id = $1",
        session_id,
    )
    if not rows:
        return 0

    heights = compute_heights_iterative(rows)
    if not heights:
        return 0

    async with conn.transaction():
        await conn.executemany(
            "UPDATE events SET subtree_height = $1 "
            "WHERE session_id = $2 AND id = $3",
            [(h, session_id, i) for i, h in heights.items()],
        )
    return len(heights)


async def run(dsn: str, dry_run: bool) -> None:
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
    try:
        async with pool.acquire() as conn:
            if dry_run:
                pending = await conn.fetchval(
                    r"SELECT COUNT(*) FROM events "
                    r"WHERE parent_event_id IS NULL "
                    r"  AND payload->>'parent_event_id' ~ '^\d{1,10}$' "
                    r"  AND (payload->>'parent_event_id')::BIGINT BETWEEN 1 AND 2147483647"
                )
                total_sessions = await conn.fetchval("SELECT COUNT(*) FROM sessions")
                total_events = await conn.fetchval("SELECT COUNT(*) FROM events")
                logger.info(
                    "[DRY RUN] step 2 would migrate %d payload.parent_event_id rows",
                    pending,
                )
                logger.info(
                    "[DRY RUN] step 3 would recompute subtree_height for %d events "
                    "across %d sessions",
                    total_events,
                    total_sessions,
                )
                return

            # 단계 2: payload -> parent_event_id 컬럼 이관
            logger.info("[step 2] migrating payload.parent_event_id to column ...")
            migrated = await migrate_parent_column(conn)
            logger.info("[step 2] migrated %d rows", migrated)

            # 단계 3: 세션별 DFS로 subtree_height 재계산
            session_ids = await list_session_ids(conn)
            logger.info("[step 3] recomputing subtree_height for %d sessions", len(session_ids))

            total_updated = 0
            for idx, session_id in enumerate(session_ids, start=1):
                updated = await backfill_session(conn, session_id)
                total_updated += updated
                if idx % 50 == 0 or idx == len(session_ids):
                    logger.info(
                        "[step 3] %d/%d sessions processed (events updated: %d)",
                        idx,
                        len(session_ids),
                        total_updated,
                    )

            # 검증 쿼리
            non_default = await conn.fetchval(
                "SELECT COUNT(*) FROM events WHERE subtree_height > 1"
            )
            logger.info("[verify] events with subtree_height > 1: %d", non_default)
    finally:
        await pool.close()


def resolve_dsn() -> str:
    dsn = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        print(
            "ERROR: TEST_DATABASE_URL 또는 DATABASE_URL 환경변수를 설정해야 합니다.",
            file=sys.stderr,
        )
        sys.exit(2)
    return dsn


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="실제 변경 없이 영향 범위만 출력",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    dsn = resolve_dsn()
    asyncio.run(run(dsn, args.dry_run))


if __name__ == "__main__":
    main()
