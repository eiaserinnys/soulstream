"""서버 기동 시 레거시 데이터(SQLite/JSONL) → PostgreSQL 자동 이관.

서버 시작 시 레거시 파일(soulstream.db, events/)이
존재하면 PostgreSQL로 이관하고, 검증 후 원본을 .deprecated로 리네이밍한다.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import asyncpg

    from soul_server.service.postgres_session_db import PostgresSessionDB

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 데이터 클래스
# ---------------------------------------------------------------------------


@dataclass
class DryRunReport:
    """드라이런 결과 보고서."""

    legacy_files: dict[str, str] = field(default_factory=dict)
    source_counts: dict[str, int] = field(default_factory=dict)
    event_type_distribution: dict[str, int] = field(default_factory=dict)
    sample_mappings: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    sessions_to_create: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------


async def auto_migrate(
    session_db: PostgresSessionDB,
    data_dir: str,
    *,
    dry_run: bool = False,
) -> Optional[DryRunReport]:
    """서버 기동 시 레거시 데이터 자동 이관.

    Args:
        session_db: connect() 완료된 PostgresSessionDB 인스턴스.
        data_dir: 데이터 디렉토리 경로 (settings.data_dir).
        dry_run: True이면 DB에 쓰지 않고 DryRunReport를 반환.

    Returns:
        dry_run=True이면 DryRunReport, dry_run=False이면 None.

    레거시 파일이 없으면 즉시 리턴.
    이관 실패 시 경고 로그만 남기고 서버 기동은 계속.
    """
    try:
        legacy = _detect_legacy_files(data_dir)
        if not legacy:
            return None

        logger.info(f"레거시 데이터 감지: {list(legacy.keys())}")
        node_id = session_db.node_id
        pool = session_db.pool
        source_counts = _count_sources(legacy)
        logger.info(f"소스 레코드: {source_counts}")

        if dry_run:
            report = DryRunReport(
                legacy_files={k: str(v) for k, v in legacy.items()},
                source_counts=source_counts,
            )
            # JSONL 이벤트 분석
            if "events_dir" in legacy:
                _analyze_jsonl_events(legacy["events_dir"], report)
            # SQLite 세션 분석 — sessions_to_create에서 SQLite 세션 제외
            if "sessions_db" in legacy:
                _analyze_sqlite_sessions(legacy["sessions_db"], report)
            return report

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
    return None


async def auto_migrate_dry_run(data_dir: str) -> Optional[DryRunReport]:
    """DB 연결 없이 파일 파싱과 매핑 검증만 수행하는 CLI 전용 드라이런.

    Args:
        data_dir: 데이터 디렉토리 경로.

    Returns:
        레거시 파일이 있으면 DryRunReport, 없으면 None.
    """
    legacy = _detect_legacy_files(data_dir)
    if not legacy:
        return None

    source_counts = _count_sources(legacy)
    report = DryRunReport(
        legacy_files={k: str(v) for k, v in legacy.items()},
        source_counts=source_counts,
    )

    if "events_dir" in legacy:
        _analyze_jsonl_events(legacy["events_dir"], report)

    if "sessions_db" in legacy:
        _analyze_sqlite_sessions(legacy["sessions_db"], report)

    return report


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


def _unwrap_event(raw: dict) -> tuple[int, dict]:
    """JSONL 라인의 raw dict에서 (event_id, event_dict)를 추출.

    SessionCache 포맷: {"id": N, "event": {...}} → (N, event_dict)
    레거시 flat 포맷: {"id": N, "type": "...", ...} → (N, raw 자체)
    """
    if "event" in raw and isinstance(raw["event"], dict):
        return raw.get("id", 0), raw["event"]
    return raw.get("id", 0), raw


# ---------------------------------------------------------------------------
# 드라이런 분석 헬퍼
# ---------------------------------------------------------------------------


def _analyze_jsonl_events(events_dir: Path, report: DryRunReport) -> None:
    """JSONL 파일을 파싱하여 DryRunReport에 분석 결과를 채운다."""
    sample_count = 0

    for jsonl_file in sorted(events_dir.glob("*.jsonl")):
        sid = jsonl_file.stem
        parse_errors = 0

        with open(jsonl_file, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    parse_errors += 1
                    continue

                eid, evt = _unwrap_event(raw)
                event_type = evt.get("type", evt.get("event_type", "unknown"))
                searchable = _extract_searchable(evt)

                # 타입 분포
                report.event_type_distribution[event_type] = (
                    report.event_type_distribution.get(event_type, 0) + 1
                )

                # 샘플 매핑 (처음 3건)
                if sample_count < 3:
                    report.sample_mappings.append({
                        "session_id": sid,
                        "event_id": eid,
                        "event_type": event_type,
                        "searchable_preview": searchable[:100] if searchable else "",
                    })
                    sample_count += 1

                # created_at 누락 경고
                if not evt.get("created_at"):
                    if len(report.warnings) < 20:
                        report.warnings.append(
                            f"{sid}#{eid}: created_at 누락 (현재 시각으로 대체됨)"
                        )

        if parse_errors:
            report.warnings.append(
                f"{jsonl_file.name}: {parse_errors}개 행 JSON 파싱 실패"
            )

        # JSONL에서 자동 생성될 세션 후보
        report.sessions_to_create.append(sid)


def _analyze_sqlite_sessions(db_path: Path, report: DryRunReport) -> None:
    """SQLite에 존재하는 세션 ID를 sessions_to_create에서 제외한다."""
    try:
        conn = sqlite3.connect(str(db_path))
        rows = conn.execute("SELECT session_id FROM sessions").fetchall()
        conn.close()
        existing_sids = {row[0] for row in rows}
        report.sessions_to_create = [
            sid for sid in report.sessions_to_create if sid not in existing_sids
        ]
    except Exception:
        logger.warning("SQLite 세션 조회 실패", exc_info=True)


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
                "SELECT migration_upsert_folder($1, $2, $3)",
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
    display_name을 포함한 전체 세션 데이터를 JSONB로 패킹하여
    migration_upsert_session 프로시저에 전달한다.
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

            session_data = {
                "folder_id": folder_id,
                "display_name": display_name,
                "node_id": node_id,
                "session_type": session_type,
                "status": status,
                "prompt": prompt,
                "client_id": client_id,
                "claude_session_id": claude_session_id,
                "last_message": last_message,
                "metadata": metadata,
                "was_running_at_shutdown": was_running,
                "last_event_id": last_event_id,
                "last_read_event_id": last_read_event_id,
                "created_at": created_at.isoformat(),
                "updated_at": updated_at.isoformat(),
            }

            await conn.execute(
                "SELECT migration_upsert_session($1, $2::jsonb)",
                sid,
                json.dumps(session_data, ensure_ascii=False),
            )
            session_count += 1

    logger.info(f"SQLite에서 {session_count}개 세션 이관 완료")
    return session_count


def _sanitize_payload(payload: str) -> str:
    """PostgreSQL jsonb에 넣을 수 없는 문자를 제거.

    PostgreSQL은 jsonb/text에 \\u0000 (NULL 바이트)을 허용하지 않는다.
    """
    return payload.replace("\x00", "").replace("\\u0000", "")


async def _migrate_events_from_db(pool: asyncpg.Pool, db_path: Path, node_id: str) -> int:
    """SQLite events 테이블 → PostgreSQL events 테이블 이관.

    executemany()로 배치 INSERT하여 성능을 확보한다.
    배치 실패 시 해당 청크만 개별 INSERT로 폴백.
    """
    conn_sqlite = sqlite3.connect(str(db_path))
    conn_sqlite.row_factory = sqlite3.Row
    rows = conn_sqlite.execute("SELECT * FROM events ORDER BY session_id, id").fetchall()
    conn_sqlite.close()

    # 전체 레코드를 튜플 리스트로 변환
    records = []
    for row in rows:
        records.append((
            row["session_id"],
            row["id"],
            row["event_type"],
            _sanitize_payload(row["payload"]),
            _sanitize_payload(row["searchable_text"] or ""),
            _parse_dt(row["created_at"]),
        ))

    query = "SELECT migration_insert_event($1, $2, $3, $4::jsonb, $5, $6)"

    event_count = 0
    skipped = 0
    chunk_size = 1000

    async with pool.acquire() as conn:
        for i in range(0, len(records), chunk_size):
            chunk = records[i:i + chunk_size]
            try:
                await conn.executemany(query, chunk)
                event_count += len(chunk)
            except Exception as e:
                logger.warning(f"배치 INSERT 실패 (chunk {i}~{i+len(chunk)}), 개별 폴백: {e}")
                for rec in chunk:
                    try:
                        await conn.execute(query, *rec)
                        event_count += 1
                    except Exception as e2:
                        skipped += 1
                        if skipped <= 5:
                            logger.warning(f"이벤트 이관 실패 (skip): {rec[0]}#{rec[1]}: {e2}")

    if skipped:
        logger.warning(f"SQLite events: {skipped}개 이벤트 이관 실패 (건너뜀)")
    logger.info(f"SQLite events에서 {event_count}개 이벤트 이관 완료")
    return event_count


async def _migrate_events_from_jsonl(pool: asyncpg.Pool, events_dir: Path, node_id: str) -> int:
    """JSONL events/ → PostgreSQL events 테이블 이관.

    JSONL 전용 레거시 노드용. 파일명(llm-*.jsonl / sess-*.jsonl)으로
    세션 타입을 구분하여 세션 레코드가 없으면 자동 생성한다.

    SessionCache 포맷 {"id": N, "event": {...}}과
    레거시 flat 포맷 {"id": N, "type": "...", ...}을 모두 지원한다.
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

        # 세션이 없으면 자동 생성 (migration_ensure_session)
        async with pool.acquire() as conn:
            _, first_evt = _unwrap_event(events[0])
            _, last_evt = _unwrap_event(events[-1])
            first_ts = _parse_dt(first_evt.get("created_at"))
            last_ts = _parse_dt(last_evt.get("created_at"))

            session_data = {
                "folder_id": folder_id,
                "node_id": node_id,
                "session_type": session_type,
                "status": "completed",
                "created_at": first_ts.isoformat(),
                "updated_at": last_ts.isoformat(),
            }
            await conn.execute(
                "SELECT migration_ensure_session($1, $2::jsonb)",
                sid,
                json.dumps(session_data, ensure_ascii=False),
            )

            for raw in events:
                # SessionCache 포맷: {"id": N, "event": {...}}
                # 레거시 flat 포맷: {"id": N, "type": "...", ...}
                eid, evt = _unwrap_event(raw)
                event_type = evt.get("type", evt.get("event_type", "unknown"))
                payload = _sanitize_payload(json.dumps(evt, ensure_ascii=False))
                searchable = _sanitize_payload(_extract_searchable(evt))
                created_at = _parse_dt(evt.get("created_at")) if evt.get("created_at") else datetime.now(timezone.utc)

                await conn.execute(
                    "SELECT migration_insert_event($1, $2, $3, $4::jsonb, $5, $6)",
                    sid, eid, event_type, payload, searchable, created_at,
                )
                event_count += 1

        # 세션의 last_event_id 갱신
        if events:
            max_id = max(e.get("id", 0) for e in events)
            async with pool.acquire() as conn:
                await conn.execute(
                    "SELECT migration_update_last_event_id($1, $2)",
                    sid, max_id,
                )

    logger.info(f"JSONL에서 {event_count}개 이벤트 이관 완료")
    return event_count


async def _verify_migration(
    pool: asyncpg.Pool, source_counts: dict[str, int], node_id: str
) -> bool:
    """PostgreSQL 레코드 수와 source_counts 비교. 모든 항목 >= 원본이면 True.

    migration_verify 프로시저는 전체 폴더 수(시스템 폴더 포함)를 반환하므로,
    source_counts["folders"](사용자 정의 폴더만) 와의 비교에서는 항상 >=가 성립한다.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM migration_verify($1)", node_id)

    pg_sessions = row["session_count"]
    pg_events = row["event_count"]
    pg_folders = row["folder_count"]

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
        logger.info(f"검증 통과: 세션={pg_sessions}, 이벤트={pg_events}, 폴더={pg_folders}")
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


# ---------------------------------------------------------------------------
# CLI 진입점
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import argparse
    import asyncio

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    parser = argparse.ArgumentParser(description="레거시 데이터 마이그레이션 드라이런")
    parser.add_argument("--data-dir", required=True, help="데이터 디렉토리 경로")
    args = parser.parse_args()

    report = asyncio.run(auto_migrate_dry_run(args.data_dir))
    if report is None:
        print("레거시 파일이 감지되지 않았습니다.")
    else:
        print(f"\n=== 레거시 데이터 마이그레이션 드라이런 ===")
        print(f"감지된 파일: {report.legacy_files}")
        print(f"소스 레코드: {report.source_counts}")
        print(f"\n이벤트 타입 분포:")
        for t, c in sorted(report.event_type_distribution.items(), key=lambda x: -x[1]):
            print(f"  {t}: {c}")
        print(f"\n매핑 샘플 (처음 3건):")
        for s in report.sample_mappings:
            print(f"  {s}")
        if report.sessions_to_create:
            print(f"\n자동 생성될 세션 ({len(report.sessions_to_create)}개):")
            for sid in report.sessions_to_create[:10]:
                print(f"  {sid}")
            if len(report.sessions_to_create) > 10:
                print(f"  ... 외 {len(report.sessions_to_create) - 10}개")
        if report.warnings:
            print(f"\n⚠️  경고 ({len(report.warnings)}건):")
            for w in report.warnings:
                print(f"  - {w}")
        print()
