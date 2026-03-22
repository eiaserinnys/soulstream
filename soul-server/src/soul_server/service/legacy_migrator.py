"""서버 기동 시 레거시 데이터(SQLite/JSONL) → PostgreSQL 자동 이관.

서버 시작 시 레거시 파일(sessions.db, events/, session_catalog.json)이
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

        session_folder_map = _build_session_folder_map(legacy.get("catalog"))

        if "catalog" in legacy:
            await _migrate_catalog(pool, legacy["catalog"], node_id)
        if "sessions_db" in legacy:
            await _migrate_sessions(
                pool, legacy["sessions_db"], node_id, session_folder_map=session_folder_map
            )
        if "events_dir" in legacy:
            await _migrate_events(pool, legacy["events_dir"], node_id)

        if await _verify_migration(pool, source_counts, node_id):
            _deprecate_files(legacy)
            logger.info("레거시 데이터 이관 완료, 원본 deprecated 처리됨")
        else:
            logger.warning("이관 검증 실패: 원본 파일을 유지합니다")
    except Exception:
        logger.warning("레거시 데이터 이관 중 오류 발생, 서버 기동은 계속합니다", exc_info=True)


# ---------------------------------------------------------------------------
# 헬퍼 — 날짜/텍스트 파싱 (기존 migrate_to_postgres.py에서 이동)
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

    catalog = base / "session_catalog.json"
    if catalog.exists():
        result["catalog"] = catalog

    sessions_db = base / "sessions.db"
    if sessions_db.exists():
        result["sessions_db"] = sessions_db

    events_dir = base / "events"
    if events_dir.is_dir():
        result["events_dir"] = events_dir

    return result


def _count_sources(legacy: dict[str, Path]) -> dict[str, int]:
    """이관 전 원본 레코드 수 집계.

    Returns:
        {"catalog_folders": int, "sessions": int, "events": int}
        - catalog_folders: 사용자 정의 폴더 수 (시스템 폴더 제외)
        - sessions: SQLite 세션 레코드 수
        - events: 전체 JSONL 이벤트 레코드 수 (행 수 합계)
    """
    counts: dict[str, int] = {"catalog_folders": 0, "sessions": 0, "events": 0}

    # catalog_folders: 시스템 폴더 제외한 사용자 정의 폴더 수
    catalog_path = legacy.get("catalog")
    if catalog_path:
        try:
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            from soul_server.service.postgres_session_db import PostgresSessionDB

            system_names = set(PostgresSessionDB.DEFAULT_FOLDERS.values())
            system_ids = set(PostgresSessionDB.DEFAULT_FOLDERS.keys())
            user_folders = 0
            for folder in catalog.get("folders", []):
                fid = folder.get("id", "")
                fname = folder.get("name", "")
                if fid not in system_ids and fname not in system_names:
                    # 시스템 폴더 이름 패턴 매칭도 확인
                    if not _is_system_folder(fname):
                        user_folders += 1
            counts["catalog_folders"] = user_folders
        except Exception:
            logger.warning("session_catalog.json 파싱 실패 (카운트)", exc_info=True)

    # sessions
    db_path = legacy.get("sessions_db")
    if db_path:
        try:
            conn = sqlite3.connect(str(db_path))
            cursor = conn.execute("SELECT COUNT(*) FROM sessions")
            counts["sessions"] = cursor.fetchone()[0]
            conn.close()
        except Exception:
            logger.warning("sessions.db 카운트 실패", exc_info=True)

    # events: JSONL 행 수 합계
    events_dir = legacy.get("events_dir")
    if events_dir:
        total = 0
        for jsonl_file in events_dir.glob("*.jsonl"):
            try:
                with open(jsonl_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            json.loads(line)
                            total += 1
                        except json.JSONDecodeError:
                            continue
            except Exception:
                logger.warning(f"이벤트 파일 카운트 실패: {jsonl_file}", exc_info=True)
        counts["events"] = total

    return counts


def _is_system_folder(name: str) -> bool:
    """시스템 폴더 이름인지 판별."""
    lower = name.lower()
    return "클로드" in name or "claude" in lower or "llm" in lower


def _build_session_folder_map(catalog_path: Path | None) -> dict[str, str]:
    """session_catalog.json에서 {session_id: folder_id} 매핑 구축.

    session_catalog.json의 sessions 항목은 folder_id 키(snake_case)를 사용한다.
    시스템 폴더(클로드/llm)는 고정 ID로 매핑하고,
    사용자 정의 폴더는 원래 UUID를 그대로 사용한다.
    """
    if catalog_path is None or not catalog_path.exists():
        return {}

    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("session_catalog.json 파싱 실패 (폴더 매핑)", exc_info=True)
        return {}

    # UUID → 고정 ID 매핑
    folder_id_map: dict[str, str] = {}
    for folder in catalog.get("folders", []):
        old_id = folder["id"]
        name = folder.get("name", "")
        if "클로드" in name or "claude" in name.lower():
            folder_id_map[old_id] = "claude"
        elif "llm" in name.lower():
            folder_id_map[old_id] = "llm"
        else:
            folder_id_map[old_id] = old_id

    # 세션 → 폴더 매핑
    session_map: dict[str, str] = {}
    for sid, info in catalog.get("sessions", {}).items():
        old_fid = info.get("folder_id")
        if old_fid and old_fid in folder_id_map:
            session_map[sid] = folder_id_map[old_fid]
        else:
            session_map[sid] = "claude"  # 기본값

    return session_map


async def _migrate_catalog(pool: asyncpg.Pool, catalog_path: Path, node_id: str) -> int:
    """session_catalog.json 이관: 폴더 삽입 + sessions.folder_id 갱신.

    Returns:
        삽입된 사용자 정의 폴더 수.
    """
    try:
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("session_catalog.json 파싱 실패 (이관)", exc_info=True)
        return 0

    user_folder_count = 0
    folder_id_map: dict[str, str] = {}

    # 1. 폴더 삽입
    for folder in catalog.get("folders", []):
        old_id = folder["id"]
        name = folder.get("name", "")

        if "클로드" in name or "claude" in name.lower():
            folder_id_map[old_id] = "claude"
        elif "llm" in name.lower():
            folder_id_map[old_id] = "llm"
        else:
            folder_id_map[old_id] = old_id
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO folders (id, name, sort_order) VALUES ($1, $2, $3) "
                    "ON CONFLICT (id) DO NOTHING",
                    old_id,
                    name,
                    folder.get("sort_order", 99),
                )
            user_folder_count += 1
            logger.info(f"  사용자 폴더 생성: {name} ({old_id})")

    # 2. 세션-폴더 매핑 갱신
    for sid, info in catalog.get("sessions", {}).items():
        old_fid = info.get("folder_id")
        new_fid = folder_id_map.get(old_fid, "claude") if old_fid else "claude"
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE sessions SET folder_id = $1 WHERE session_id = $2",
                new_fid,
                sid,
            )

    logger.info(f"카탈로그 이관: 사용자 폴더 {user_folder_count}개, 세션 매핑 {len(catalog.get('sessions', {}))}개")
    return user_folder_count


async def _migrate_sessions(
    pool: asyncpg.Pool,
    db_path: Path,
    node_id: str,
    *,
    session_folder_map: dict[str, str],
) -> int:
    """SQLite sessions.db → PostgreSQL sessions 테이블 이관."""
    conn_sqlite = sqlite3.connect(str(db_path))
    conn_sqlite.row_factory = sqlite3.Row
    cursor = conn_sqlite.execute("SELECT * FROM sessions")
    rows = cursor.fetchall()
    conn_sqlite.close()

    session_count = 0
    async with pool.acquire() as conn:
        for row in rows:
            sid = row["session_id"]
            folder_id = session_folder_map.get(sid, "claude")
            status = row["status"] if "status" in row.keys() else "completed"
            session_type = row["session_type"] if "session_type" in row.keys() else "claude"
            last_message = row["last_message"] if "last_message" in row.keys() else None
            metadata = row["metadata"] if "metadata" in row.keys() else None
            created_at = _parse_dt(row["created_at"]) if "created_at" in row.keys() else datetime.now(timezone.utc)
            updated_at = _parse_dt(row["updated_at"]) if "updated_at" in row.keys() else created_at

            await conn.execute(
                """INSERT INTO sessions
                   (session_id, folder_id, node_id, status, session_type,
                    last_message, metadata, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                   ON CONFLICT (session_id) DO NOTHING""",
                sid,
                folder_id,
                node_id,
                status,
                session_type,
                last_message,
                metadata,
                created_at,
                updated_at,
            )
            session_count += 1

    logger.info(f"SQLite에서 {session_count}개 세션 이관 완료")
    return session_count


async def _migrate_events(pool: asyncpg.Pool, events_dir: Path, node_id: str) -> int:
    """JSONL events/ → PostgreSQL events 테이블 이관."""
    event_count = 0
    for jsonl_file in sorted(events_dir.glob("*.jsonl")):
        sid = jsonl_file.stem
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

        async with pool.acquire() as conn:
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
                    sid,
                    eid,
                    event_type,
                    payload,
                    searchable,
                    created_at,
                )
                event_count += 1

        # 세션의 last_event_id 갱신
        if events:
            max_id = max(e.get("id", 0) for e in events)
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE sessions SET last_event_id = $1 "
                    "WHERE session_id = $2 AND (last_event_id IS NULL OR last_event_id < $1)",
                    max_id,
                    sid,
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
    if pg_folders < source_counts["catalog_folders"]:
        logger.warning(f"폴더 수 불일치: PG={pg_folders}, 원본={source_counts['catalog_folders']}")
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
