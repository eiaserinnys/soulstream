#!/usr/bin/env python3
"""sessions.metadata에 caller_info entry가 부재한 세션을 events 테이블의 최근 caller_info wire로
backfill (R-6 G-20).

배경
----
R-6 fix(2026-05-11, atom G-20) 이전 영속화된 세션은 *최초 생성 시점*에만
`_register_new_session_async`가 caller_info를 metadata에 append했으며, 후속 intervene은
`task.caller_info` 인메모리만 갱신하고 DB metadata는 미갱신이었다. 그 결과 R-2 G-9 fix
(2026-05-10) *이전* 생성된 세션 중 caller_info를 처음부터 못 받은 케이스는 metadata에
caller_info entry가 0건. REST `/api/sessions` 응답이 `_session_to_response` →
`extract_caller_info_from_metadata` → None → enrichment owner fallback 발동으로
*첫 동기화 시* dashboard owner Google 프로필 표시 (sess-20260419114049-8cf09982 라이브 재현).

본 script는 그런 세션을 *events 테이블에 영속된 최근 user_message/intervention_sent wire의
caller_info*로 backfill하여 *기존 세션의 첫 동기화 즉시 정합* 달성. R-6 (c) fix(코드 변경)는
*미래 진입* 정합을 보장, 본 (a) backfill은 *과거 영속 데이터* 정합을 보장 — 두 fix 시너지.

실행 절차
---------
    1. (dry-run) 영향 세션 enumerate + 추출될 caller_info entry 미리보기
    2. (실제) 백업 jsonl 작성 + UPDATE sessions.metadata = metadata || jsonb_build_array(entry)

Usage
-----
    # 사전 측정
    DATABASE_URL=postgresql://... python scripts/backfill_caller_info_r6.py --dry-run

    # 실 실행 (백업 jsonl 경로 명시)
    DATABASE_URL=postgresql://... python scripts/backfill_caller_info_r6.py \\
      --backup-path /path/to/backup.jsonl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional

import asyncpg

logger = logging.getLogger("backfill_caller_info_r6")


# 영향 세션을 찾는 SQL — sessions.metadata에 caller_info entry가 없고, events에
# user_message/intervention_sent wire 중 하나라도 caller_info 키를 가진 세션.
# 각 행에 대해 마지막(가장 최근) 그런 wire의 payload->'caller_info'를 함께 반환.
_FIND_AFFECTED_SQL = r"""
WITH no_caller_meta AS (
    SELECT s.session_id, s.node_id, s.created_at
    FROM sessions s
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.metadata) e
        WHERE e->>'type' = 'caller_info'
    )
),
recent_wire AS (
    SELECT DISTINCT ON (e.session_id)
        e.session_id,
        e.payload->'caller_info' AS caller_info,
        e.created_at AS wire_created_at,
        e.event_type
    FROM events e
    JOIN no_caller_meta n ON n.session_id = e.session_id
    WHERE e.event_type IN ('user_message','intervention_sent')
      AND e.payload ? 'caller_info'
      AND jsonb_typeof(e.payload->'caller_info') = 'object'
    ORDER BY e.session_id, e.id DESC
)
SELECT
    n.session_id,
    n.node_id,
    n.created_at AS session_created_at,
    r.caller_info,
    r.wire_created_at,
    r.event_type
FROM no_caller_meta n
JOIN recent_wire r ON r.session_id = n.session_id
ORDER BY n.session_id;
"""


_BACKFILL_UPDATE_SQL = r"""
UPDATE sessions
SET metadata = COALESCE(metadata, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('type', 'caller_info', 'value', $2::jsonb)
)
WHERE session_id = $1
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(metadata) e
    WHERE e->>'type' = 'caller_info'
  );
"""


async def find_affected(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    """영향 세션 enumerate + 추출될 caller_info entry 미리보기."""
    rows = await conn.fetch(_FIND_AFFECTED_SQL)
    return [
        {
            "session_id": row["session_id"],
            "node_id": row["node_id"],
            "session_created_at": row["session_created_at"].isoformat(),
            "wire_created_at": row["wire_created_at"].isoformat(),
            "event_type": row["event_type"],
            "caller_info": json.loads(row["caller_info"]) if isinstance(row["caller_info"], str) else row["caller_info"],
        }
        for row in rows
    ]


async def backup_before_update(
    conn: asyncpg.Connection,
    session_ids: list[str],
    backup_path: Path,
) -> int:
    """UPDATE 전 sessions row의 현재 metadata를 jsonl로 백업.

    백업 형식 (한 줄당 하나의 세션):
        {"session_id": str, "metadata": <jsonb 원본 string>, "backed_up_at": ISO8601}
    """
    if not session_ids:
        return 0
    rows = await conn.fetch(
        "SELECT session_id, metadata, updated_at FROM sessions WHERE session_id = ANY($1::text[])",
        session_ids,
    )
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    from datetime import datetime, timezone

    backed_up_at = datetime.now(timezone.utc).isoformat()
    with backup_path.open("w", encoding="utf-8") as f:
        for row in rows:
            metadata = row["metadata"]
            if not isinstance(metadata, str):
                metadata = json.dumps(metadata)
            f.write(json.dumps({
                "session_id": row["session_id"],
                "metadata": metadata,
                "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
                "backed_up_at": backed_up_at,
            }, ensure_ascii=False) + "\n")
    return len(rows)


async def apply_backfill(
    conn: asyncpg.Connection,
    affected: list[dict[str, Any]],
) -> int:
    """UPDATE sessions.metadata = metadata || jsonb_build_array(entry).

    트랜잭션 안에서 실행. 같은 세션이 그 사이에 caller_info를 받았으면 (race) WHERE 조건이
    배제하여 중복 append 방지.
    """
    n = 0
    async with conn.transaction():
        for item in affected:
            session_id = item["session_id"]
            caller_info_json = json.dumps(item["caller_info"], ensure_ascii=False)
            result = await conn.execute(_BACKFILL_UPDATE_SQL, session_id, caller_info_json)
            # asyncpg execute는 "UPDATE N" 문자열 반환
            try:
                updated = int(result.rsplit(" ", 1)[-1])
            except (ValueError, IndexError):
                updated = 0
            n += updated
            if updated:
                logger.info("backfilled session=%s wire=%s", session_id, item["event_type"])
            else:
                logger.warning("skipped session=%s (race or NOT EXISTS guard)", session_id)
    return n


async def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="실 UPDATE 없이 영향 세션과 추출될 caller_info entry만 출력.",
    )
    parser.add_argument(
        "--backup-path", type=Path,
        default=None,
        help="UPDATE 전 백업 jsonl 경로. --dry-run이 아니면 필수.",
    )
    parser.add_argument(
        "--database-url", type=str,
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL 접속 URL. 기본은 DATABASE_URL 환경변수.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    if not args.database_url:
        logger.error("DATABASE_URL이 비어있다. --database-url 또는 환경변수로 지정.")
        return 2

    if not args.dry_run and args.backup_path is None:
        logger.error("--dry-run이 아니면 --backup-path 필수 (백업 jsonl 경로).")
        return 2

    conn = await asyncpg.connect(args.database_url)
    try:
        affected = await find_affected(conn)
        logger.info("affected sessions=%d", len(affected))

        if not affected:
            logger.info("backfill 대상 세션 0건 — 종료.")
            return 0

        for item in affected:
            ci = item["caller_info"]
            logger.info(
                "  session=%s node=%s wire=%s source=%s display_name=%s avatar_url=%s",
                item["session_id"],
                item["node_id"],
                item["event_type"],
                ci.get("source"),
                ci.get("display_name"),
                ci.get("avatar_url"),
            )

        if args.dry_run:
            logger.info("dry-run — UPDATE 실행 안 함.")
            return 0

        session_ids = [item["session_id"] for item in affected]
        n_backed_up = await backup_before_update(conn, session_ids, args.backup_path)
        logger.info("backed up %d rows to %s", n_backed_up, args.backup_path)

        n_updated = await apply_backfill(conn, affected)
        logger.info("backfilled %d sessions.", n_updated)
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
