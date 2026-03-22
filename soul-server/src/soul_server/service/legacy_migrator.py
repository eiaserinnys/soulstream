"""서버 기동 시 레거시 데이터(SQLite/JSONL) → PostgreSQL 자동 이관.

서버 시작 시 레거시 파일(soulstream.db, events/)이
존재하면 PostgreSQL로 이관하고, 검증 후 원본을 .deprecated로 리네이밍한다.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import asyncpg

    from soul_server.service.postgres_session_db import PostgresSessionDB

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------


async def auto_migrate(session_db: PostgresSessionDB, data_dir: str) -> None:
    """서버 기동 시 레거시 데이터 자동 이관.

    Args:
        session_db: connect() 완료된 PostgresSessionDB 인스턴스.
        data_dir: 데이터 디렉토리 경로 (settings.data_dir).

    레거시 파일이 없으면 즉시 리턴.
    이관 실패 시 경고 로그만 남기고 서버 기동은 계속.
    """
    try:
        legacy = _detect_legacy_files(data_dir)
        if not legacy:
            return

        logger.info(f"레거시 데이터 감지: {list(legacy.keys())}")
        node_id = session_db.node_id
        pool = session_db.pool
        source_counts = _count_sources(legacy)
        logger.info(f"소스 레코드: {source_counts}")

        if "sessions_db" in legacy:
            await _migrate_folders(pool, legacy["sessions_db"])
            await _migrate_sessions(pool, legacy["sessions_db"], node_id)
            await _migrate_events_from_db(pool, legacy["sessions_db"], node_id)
        if "events_dir" in legacy:
            await _migrate_events_from_jsonl(pool, legacy["events_dir"], node_id)

        if await _verify_migration(pool, source_counts, node_id):
            _deprecate_files(legacy)
            logger.info("레거시 데이터 이관 완료, 원본 deprecated 처리됨")
        else:
            logger.warning("이관 검증 실패: 원본 파일을 유지합니다")
    except Exception:
        logger.warning("레거시 데이터 이관 중 오류 발생, 서버 기동은 계속합니다", exc_info=True)


# ---------------------------------------------------------------------------
# 헬퍼 — 날짜/텍스트 파싱
# ---------------------------------------------------------------------------


def _parse_dt(val: object) -> datetime:
    """문자열 또는 None → datetime (UTC)."""
    if val is None:
        return datetime.now(timezone.utc)
    if isinstance(val, datetime):
        return val
    try:
        return datetime.fromisoformat(str(val).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return datetime.now(timezone.utc)


def _extract_searchable(evt: dict) -> str:
    """이벤트에서 검색 가능 텍스트 추출."""
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


# ---------------------------------------------------------------------------
# 내부 함수
# ---------------------------------------------------------------------------


def _detect_legacy_files(data_dir: str) -> dict[str, Path]:
    """존재하는 레거시 파일 경로 반환.

    .deprecated 접미사가 이미 붙은 파일은 무시한다.
    """
    base = Path(data_dir)
    result: dict[str, Path] = {}

    sessions_db = base / "soulstream.db"
    if sessions_db.exists():
        result["sessions_db"] = sessions_db

    events_dir = base / "events"
    if events_dir.is_dir():
        result["events_dir"] = events_dir

    return result


def _count_sources(legacy: dict[str, Path]) -> dict[str, int]:
    """이관 전 원본 레코드 수 집계.

    Returns:
        {"folders": int, "sessions": int, "events": int}
        - folders: SQLite folders 테이블의 사용자 정의 폴더 수
        - sessions: SQLite sessions 테이블의 세션 수
        - events: 전체 JSONL 이벤트 레코드 수 (행 수 합계)
    """
    counts: dict[str, int] = {"folders": 0, "sessions": 0, "events": 0}

    db_path = legacy.get("sessions_db")
    if db_path:
        try:
            conn = sqlite3.connect(str(db_path))
            # 폴더 수 (시스템 폴더 제외)
            rows = conn.execute("SELECT id, name FROM folders").fetchall()
            user_folders = 0
            for fid, fname in rows:
                if not _is_system_folder(fid, fname):
                    user_folders += 1
            counts["folders"] = user_folders
            # 세션 수
            counts["sessions"] = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            conn.close()
        except Exception:
            logger.warning("soulstream.db 카운트 실패", exc_info=True)

    # events: SQLite events 테이블 + JSONL 행 수 합계
    if db_path:
        try:
            conn = sqlite3.connect(str(db_path))
            counts["events"] += conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            conn.close()
        except Exception:
            logger.warning("soulstream.db events 카운트 실패", exc_info=True)

    events_dir = legacy.get("events_dir")
    if events_dir:
        for jsonl_file in events_dir.glob("*.jsonl"):
            try:
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.strip():
                            try:
                                json.loads(line)
                                counts["events"] += 1
                            except json.JSONDecodeError:
                                continue
            except Exception:
                logger.warning(f"이벤트 파일 카운트 실패: {jsonl_file}", exc_info=True)

    return counts


def _is_system_folder(folder_id: str, name: str) -> bool:
    """시스템 폴더인지 판별.

    PostgresSessionDB.DEFAULT_FOLDERS의 고정 ID('claude', 'llm')에 매핑되는
    폴더를 시스템 폴더로 취급한다.
    """
    lower = name.lower()
    if folder_id in ("claude", "llm"):
        return True
    if "클로드" in name or "claude" in lower:
        return True
    if "llm" in lower:
        return True
    return False


def _map_folder_id(folder_id: str, name: str) -> str:
    """SQLite 폴더 UUID → PostgreSQL 폴더 ID 매핑.

    시스템 폴더는 고정 ID로, 사용자 정의 폴더는 원래 UUID를 유지한다.
    """
    lower = name.lower()
    if "클로드" in name or "claude" in lower:
        return "claude"
    if "llm" in lower:
        return "llm"
    return folder_id


async def _migrate_folders(pool: asyncpg.Pool, db_path: Path) -> int:
    """SQLite folders 테이블 → PostgreSQL folders 테이블 이관.

    Returns:
        삽입된 사용자 정의 폴더 수.
    """
    conn_sqlite = sqlite3.connect(str(db_path))
    conn_sqlite.row_factory = sqlite3.Row
    rows = conn_sqlite.execute("SELECT * FROM folders").fetchall()
    conn_sqlite.close()

    user_folder_count = 0
    async with pool.acquire() as conn:
        for row in rows:
            old_id = row["id"]
            name = row["name"]
            new_id = _map_folder_id(old_id, name)

            if new_id in ("claude", "llm"):
                # 시스템 폴더는 ensure_default_folders()에서 이미 생성됨
                continue

            await conn.execute(
                "INSERT INTO folders (id, name, sort_order) VALUES ($1, $2, $3) "
                "ON CONFLICT (id) DO NOTHING",
                new_id,
                name,
                row["sort_order"],
            )
            user_folder_count += 1
            logger.info(f"  사용자 폴더 생성: {name} ({new_id})")

    logger.info(f"폴더 이관: 사용자 폴더 {user_folder_count}개")
    return user_folder_count


async def _migrate_sessions(
    pool: asyncpg.Pool,
    db_path: Path,
    node_id: str,
) -> int:
    """SQLite soulstream.db → PostgreSQL sessions 테이블 이관.

    SQLite의 folder_id(UUID)를 PostgreSQL ID로 매핑하고,
    display_name을 포함한 전체 세션 데이터를 이관한다.
    """
    conn_sqlite = sqlite3.connect(str(db_path))
    conn_sqlite.row_factory = sqlite3.Row

    # 폴더 ID 매핑 테이블 구축
    folder_rows = conn_sqlite.execute("SELECT id, name FROM folders").fetchall()
    folder_id_map: dict[str, str] = {}
    for frow in folder_rows:
        folder_id_map[frow["id"]] = _map_folder_id(frow["id"], frow["name"])

    # 세션 이관
    cursor = conn_sqlite.execute("SELECT * FROM sessions")
    rows = cursor.fetchall()
    conn_sqlite.close()

    session_count = 0
    async with pool.acquire() as conn:
        for row in rows:
            sid = row["session_id"]
            keys = row.keys()
            old_folder_id = row["folder_id"] if "folder_id" in keys else None
            folder_id = folder_id_map.get(old_folder_id, "claude") if old_folder_id else "claude"
            display_name = row["display_name"] if "display_name" in keys else None
            status = row["status"] if "status" in keys else "completed"
            session_type = row["session_type"] if "session_type" in keys else "claude"
            prompt = row["prompt"] if "prompt" in keys else None
            client_id = row["client_id"] if "client_id" in keys else None
            claude_session_id = row["claude_session_id"] if "claude_session_id" in keys else None
            last_message = row["last_message"] if "last_message" in keys else None
            metadata = row["metadata"] if "metadata" in keys else None
            was_running = bool(row["was_running_at_shutdown"]) if "was_running_at_shutdown" in keys else False
            last_event_id = row["last_event_id"] if "last_event_id" in keys else None
            last_read_event_id = row["last_read_event_id"] if "last_read_event_id" in keys else None
            created_at = _parse_dt(row["created_at"]) if "created_at" in keys else datetime.now(timezone.utc)
            updated_at = _parse_dt(row["updated_at"]) if "updated_at" in keys else created_at

            await conn.execute(
                """INSERT INTO sessions
                   (session_id, folder_id, display_name, node_id, status, session_type,
                    prompt, client_id, claude_session_id,
                    last_message, metadata, was_running_at_shutdown,
                    last_event_id, last_read_event_id, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                   ON CONFLICT (session_id) DO UPDATE SET
                       folder_id = EXCLUDED.folder_id,
                       display_name = EXCLUDED.display_name,
                       prompt = EXCLUDED.prompt,
                       client_id = EXCLUDED.client_id,
                       claude_session_id = EXCLUDED.claude_session_id,
                       was_running_at_shutdown = EXCLUDED.was_running_at_shutdown,
                       last_event_id = EXCLUDED.last_event_id,
                       last_read_event_id = EXCLUDED.last_read_event_id""",
                sid,
                folder_id,
                display_name,
                node_id,
                status,
                session_type,
                prompt,
                client_id,
                claude_session_id,
                last_message,
                metadata,
                was_running,
                last_event_id,
                last_read_event_id,
                created_at,
                updated_at,
            )
            session_count += 1

    logger.info(f"SQLite에서 {session_count}개 세션 이관 완료")
    return session_count


async def _migrate_events_from_db(pool: asyncpg.Pool, db_path: Path, node_id: str) -> int:
    """SQLite events 테이블 → PostgreSQL events 테이블 이관."""
    conn_sqlite = sqlite3.connect(str(db_path))
    conn_sqlite.row_factory = sqlite3.Row
    rows = conn_sqlite.execute("SELECT * FROM events ORDER BY session_id, id").fetchall()
    conn_sqlite.close()

    event_count = 0
    async with pool.acquire() as conn:
        for row in rows:
            await conn.execute(
                """INSERT INTO events
                   (session_id, id, event_type, payload, searchable_text, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (session_id, id) DO NOTHING""",
                row["session_id"],
                row["id"],
                row["event_type"],
                row["payload"],
                row["searchable_text"] or "",
                _parse_dt(row["created_at"]),
            )
            event_count += 1

    logger.info(f"SQLite events에서 {event_count}개 이벤트 이관 완료")
    return event_count


async def _migrate_events_from_jsonl(pool: asyncpg.Pool, events_dir: Path, node_id: str) -> int:
    """JSONL events/ → PostgreSQL events 테이블 이관.

    JSONL 전용 레거시 노드용. 파일명(llm-*.jsonl / sess-*.jsonl)으로
    세션 타입을 구분하여 세션 레코드가 없으면 자동 생성한다.
    """
    event_count = 0
    for jsonl_file in sorted(events_dir.glob("*.jsonl")):
        sid = jsonl_file.stem
        session_type = "llm" if sid.startswith("llm-") else "claude"
        folder_id = "llm" if session_type == "llm" else "claude"
        events: list[dict] = []
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

        # 세션이 없으면 자동 생성
        async with pool.acquire() as conn:
            existing = await conn.fetchval(
                "SELECT 1 FROM sessions WHERE session_id = $1", sid
            )
            if not existing:
                first_ts = _parse_dt(events[0].get("created_at"))
                last_ts = _parse_dt(events[-1].get("created_at"))
                await conn.execute(
                    """INSERT INTO sessions
                       (session_id, folder_id, node_id, status, session_type, created_at, updated_at)
                       VALUES ($1, $2, $3, 'completed', $4, $5, $6)
                       ON CONFLICT (session_id) DO NOTHING""",
                    sid, folder_id, node_id, session_type, first_ts, last_ts,
                )

            for evt in events:
                eid = evt.get("id", 0)
                event_type = evt.get("type", evt.get("event_type", "unknown"))
                payload = json.dumps(evt, ensure_ascii=False)
                searchable = _extract_searchable(evt)
                created_at = _parse_dt(evt.get("created_at")) if evt.get("created_at") else datetime.now(timezone.utc)

                await conn.execute(
                    """INSERT INTO events
                       (session_id, id, event_type, payload, searchable_text, created_at)
                       VALUES ($1, $2, $3, $4, $5, $6)
                       ON CONFLICT (session_id, id) DO NOTHING""",
                    sid, eid, event_type, payload, searchable, created_at,
                )
                event_count += 1

        # 세션의 last_event_id 갱신
        if events:
            max_id = max(e.get("id", 0) for e in events)
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE sessions SET last_event_id = $1 "
                    "WHERE session_id = $2 AND (last_event_id IS NULL OR last_event_id < $1)",
                    max_id, sid,
                )

    logger.info(f"JSONL에서 {event_count}개 이벤트 이관 완료")
    return event_count


async def _verify_migration(
    pool: asyncpg.Pool, source_counts: dict[str, int], node_id: str
) -> bool:
    """PostgreSQL 레코드 수와 source_counts 비교. 모든 항목 >= 원본이면 True."""
    async with pool.acquire() as conn:
        pg_sessions = await conn.fetchval("SELECT COUNT(*) FROM sessions WHERE node_id = $1", node_id)
        pg_events = await conn.fetchval(
            "SELECT COUNT(*) FROM events e "
            "JOIN sessions s ON e.session_id = s.session_id "
            "WHERE s.node_id = $1",
            node_id,
        )
        pg_folders = await conn.fetchval(
            "SELECT COUNT(*) FROM folders WHERE id NOT IN ('claude', 'llm')"
        )

    ok = True
    if pg_sessions < source_counts["sessions"]:
        logger.warning(f"세션 수 불일치: PG={pg_sessions}, 원본={source_counts['sessions']}")
        ok = False
    if pg_events < source_counts["events"]:
        logger.warning(f"이벤트 수 불일치: PG={pg_events}, 원본={source_counts['events']}")
        ok = False
    if pg_folders < source_counts["folders"]:
        logger.warning(f"폴더 수 불일치: PG={pg_folders}, 원본={source_counts['folders']}")
        ok = False

    if ok:
        logger.info(f"검증 통과: 세션={pg_sessions}, 이벤트={pg_events}, 사용자 폴더={pg_folders}")
    return ok


def _deprecate_files(legacy: dict[str, Path]) -> None:
    """각 경로에 .deprecated 접미사 추가하여 리네이밍."""
    for key, path in legacy.items():
        deprecated = path.parent / f"{path.name}.deprecated"
        if deprecated.exists():
            logger.warning(f"이미 deprecated 파일 존재: {deprecated}")
            continue
        try:
            path.rename(deprecated)
            logger.info(f"  {path.name} → {deprecated.name}")
        except OSError as e:
            logger.warning(f"  리네이밍 실패 ({path.name}): {e}")
