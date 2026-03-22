"""SQLite + JSONL → PostgreSQL 일회성 마이그레이션 스크립트.

기존 soulstream 데이터를 PostgreSQL로 옮긴다.

사용법:
    python scripts/migrate_to_postgres.py --data-dir /path/to/data --database-url postgresql://... --node-id silent-manari

마이그레이션 대상:
1. SQLite sessions.db → PostgreSQL sessions 테이블
2. JSONL 이벤트 파일 → PostgreSQL events 테이블
3. session_catalog.json → PostgreSQL folders + session_folders 테이블
"""

import argparse
import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import asyncpg

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}


async def migrate(data_dir: str, database_url: str, node_id: str, dry_run: bool = False) -> None:
    data = Path(data_dir)
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=5)

    try:
        # 1. 기본 폴더 생성
        async with pool.acquire() as conn:
            for fid, fname in DEFAULT_FOLDERS.items():
                await conn.execute(
                    "INSERT INTO folders (id, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
                    fid, fname, 0,
                )
        logger.info("기본 폴더 생성 완료")

        # 2. session_catalog.json에서 폴더 + 세션-폴더 매핑 읽기
        catalog_path = data / "session_catalog.json"
        catalog_folders = {}  # old_folder_id -> folder_name
        session_folder_map = {}  # session_id -> new_folder_id
        if catalog_path.exists():
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            # 폴더 ID 매핑: 기존 UUID -> 새 고정 ID
            folder_id_map = {}  # old_uuid -> new_id
            for folder in catalog.get("folders", []):
                old_id = folder["id"]
                name = folder.get("name", "")
                # 시스템 폴더는 고정 ID로 매핑
                if "클로드" in name or "claude" in name.lower():
                    folder_id_map[old_id] = "claude"
                elif "llm" in name.lower():
                    folder_id_map[old_id] = "llm"
                else:
                    # 사용자 정의 폴더 → 그대로 생성
                    folder_id_map[old_id] = old_id
                    async with pool.acquire() as conn:
                        await conn.execute(
                            "INSERT INTO folders (id, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
                            old_id, name, folder.get("sort_order", 99),
                        )
                    logger.info(f"  사용자 폴더 생성: {name} ({old_id})")

            # 세션-폴더 매핑
            for sid, info in catalog.get("sessions", {}).items():
                old_fid = info.get("folder_id")
                if old_fid and old_fid in folder_id_map:
                    session_folder_map[sid] = folder_id_map[old_fid]
                else:
                    session_folder_map[sid] = "claude"  # 기본값
            logger.info(f"카탈로그에서 {len(session_folder_map)}개 세션-폴더 매핑 로드")

        # 3. SQLite sessions.db → PostgreSQL
        sqlite_path = data / "sessions.db"
        session_count = 0
        if sqlite_path.exists():
            conn_sqlite = sqlite3.connect(str(sqlite_path))
            conn_sqlite.row_factory = sqlite3.Row
            cursor = conn_sqlite.execute("SELECT * FROM sessions")
            rows = cursor.fetchall()
            conn_sqlite.close()

            async with pool.acquire() as conn:
                for row in rows:
                    sid = row["session_id"]
                    folder_id = session_folder_map.get(sid, "claude")
                    status = row["status"] if "status" in row.keys() else "completed"
                    session_type = row["session_type"] if "session_type" in row.keys() else "claude"

                    # last_message, metadata 는 JSON 문자열로 저장됨
                    last_message = row["last_message"] if "last_message" in row.keys() else None
                    metadata = row["metadata"] if "metadata" in row.keys() else None

                    created_at = _parse_dt(row["created_at"]) if "created_at" in row.keys() else datetime.now(timezone.utc)
                    updated_at = _parse_dt(row["updated_at"]) if "updated_at" in row.keys() else created_at

                    if not dry_run:
                        await conn.execute(
                            """INSERT INTO sessions
                               (session_id, folder_id, node_id, status, session_type,
                                last_message, metadata, created_at, updated_at)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                               ON CONFLICT (session_id) DO NOTHING""",
                            sid, folder_id, node_id, status, session_type,
                            last_message, metadata, created_at, updated_at,
                        )
                    session_count += 1

            logger.info(f"SQLite에서 {session_count}개 세션 마이그레이션 완료")
        else:
            logger.info("sessions.db 없음 — 세션 마이그레이션 건너뜀")

        # 4. JSONL 이벤트 → PostgreSQL
        events_dir = data / "events"
        event_count = 0
        if events_dir.exists():
            for jsonl_file in sorted(events_dir.glob("*.jsonl")):
                sid = jsonl_file.stem
                events = []
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            events.append(json.loads(line))
                        except json.JSONDecodeError:
                            continue

                if not events:
                    continue

                async with pool.acquire() as conn:
                    for evt in events:
                        eid = evt.get("id", 0)
                        event_type = evt.get("type", evt.get("event_type", "unknown"))
                        payload = json.dumps(evt, ensure_ascii=False)
                        searchable = _extract_searchable(evt)
                        created_at = _parse_dt(evt.get("created_at")) if evt.get("created_at") else datetime.now(timezone.utc)

                        if not dry_run:
                            await conn.execute(
                                """INSERT INTO events
                                   (session_id, id, event_type, payload, searchable_text, created_at)
                                   VALUES ($1, $2, $3, $4, $5, $6)
                                   ON CONFLICT (session_id, id) DO NOTHING""",
                                sid, eid, event_type, payload, searchable, created_at,
                            )
                        event_count += 1

                # 세션의 last_event_id 갱신
                if events and not dry_run:
                    max_id = max(e.get("id", 0) for e in events)
                    async with pool.acquire() as conn:
                        await conn.execute(
                            "UPDATE sessions SET last_event_id = $1 WHERE session_id = $2 AND (last_event_id IS NULL OR last_event_id < $1)",
                            max_id, sid,
                        )

            logger.info(f"JSONL에서 {event_count}개 이벤트 마이그레이션 완료")
        else:
            logger.info("events/ 디렉토리 없음 — 이벤트 마이그레이션 건너뜀")

        logger.info(f"마이그레이션 완료: 세션 {session_count}개, 이벤트 {event_count}개")

    finally:
        await pool.close()


def _parse_dt(val) -> datetime:
    """문자열 또는 None → datetime (UTC)"""
    if val is None:
        return datetime.now(timezone.utc)
    if isinstance(val, datetime):
        return val
    try:
        return datetime.fromisoformat(str(val).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return datetime.now(timezone.utc)


def _extract_searchable(evt: dict) -> str:
    """이벤트에서 검색 가능 텍스트 추출"""
    t = evt.get("type", evt.get("event_type", ""))
    if t in ("text_delta", "text"):
        return evt.get("text", "")
    if t == "thinking":
        return evt.get("thinking", "")
    if t == "tool_use":
        inp = evt.get("input", "")
        return inp if isinstance(inp, str) else json.dumps(inp, ensure_ascii=False)
    if t == "tool_result":
        return evt.get("result", "")
    if t == "user_message":
        return evt.get("text", "")
    return ""


def main():
    parser = argparse.ArgumentParser(description="SQLite/JSONL → PostgreSQL 마이그레이션")
    parser.add_argument("--data-dir", required=True, help="기존 soulstream data 디렉토리")
    parser.add_argument("--database-url", required=True, help="PostgreSQL 연결 문자열")
    parser.add_argument("--node-id", required=True, help="노드 식별자")
    parser.add_argument("--dry-run", action="store_true", help="실제 DB 쓰기 없이 실행")
    args = parser.parse_args()

    asyncio.run(migrate(args.data_dir, args.database_url, args.node_id, args.dry_run))


if __name__ == "__main__":
    main()
