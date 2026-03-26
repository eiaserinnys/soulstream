"""legacy_migrator 모듈 테스트."""

import json
import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.service.legacy_migrator import (
    DryRunReport,
    _count_sources,
    _deprecate_files,
    _detect_legacy_files,
    _extract_searchable,
    _is_system_folder,
    _map_folder_id,
    _parse_dt,
    _verify_migration,
    auto_migrate,
    auto_migrate_dry_run,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """빈 데이터 디렉토리."""
    return tmp_path


def _create_sqlite_db(db_path: Path, *, with_folders: bool = True, with_sessions: bool = True) -> None:
    """테스트용 SQLite DB 생성."""
    conn = sqlite3.connect(str(db_path))

    if with_folders:
        conn.execute(
            "CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT, sort_order INTEGER)"
        )
        conn.executemany(
            "INSERT INTO folders VALUES (?, ?, ?)",
            [
                ("uuid-claude", "⚙️ 클로드 코드 세션", 0),
                ("uuid-llm", "⚙️ LLM 세션", 1),
                ("custom-folder-1", "내 작업", 2),
                ("custom-folder-2", "✨ 소울스트림", 3),
            ],
        )

    if with_sessions:
        conn.execute(
            "CREATE TABLE sessions ("
            "session_id TEXT PRIMARY KEY, folder_id TEXT, display_name TEXT, "
            "session_type TEXT, status TEXT, prompt TEXT, client_id TEXT, "
            "claude_session_id TEXT, last_message TEXT, metadata TEXT, "
            "was_running_at_shutdown INTEGER, created_at TEXT, updated_at TEXT, "
            "last_event_id INTEGER, last_read_event_id INTEGER)"
        )
        conn.executemany(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                ("sess-1", "uuid-claude", None, "claude", "completed",
                 "test prompt 1", "client-1", "cs-1", None, None,
                 0, "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", 5, 3),
                ("sess-2", "custom-folder-1", "🔨 내 작업 세션", "claude", "active",
                 "test prompt 2", "client-2", "cs-2", "hello", None,
                 0, "2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z", 10, 8),
                ("sess-3", "custom-folder-2", None, "claude", "completed",
                 "test prompt 3", None, "cs-3", None, None,
                 1, "2026-01-03T00:00:00Z", "2026-01-03T01:00:00Z", 2, 2),
            ],
        )

    # events 테이블 (SQLite 내장 이벤트)
    conn.execute(
        "CREATE TABLE events ("
        "id INTEGER, session_id TEXT, event_type TEXT, "
        "payload TEXT, searchable_text TEXT, created_at TEXT, "
        "PRIMARY KEY (session_id, id))"
    )
    conn.executemany(
        "INSERT INTO events VALUES (?, ?, ?, ?, ?, ?)",
        [
            (1, "sess-1", "text", '{"type":"text","text":"hello"}', "hello", "2026-01-01T00:00:01Z"),
            (2, "sess-1", "tool_use", '{"type":"tool_use","input":"test"}', "test", "2026-01-01T00:00:02Z"),
            (1, "sess-2", "user_message", '{"type":"user_message","text":"hi"}', "hi", "2026-01-02T00:00:01Z"),
        ],
    )

    conn.commit()
    conn.close()


@pytest.fixture
def populated_data_dir(data_dir: Path) -> Path:
    """레거시 파일이 모두 존재하는 데이터 디렉토리."""
    # soulstream.db (folders + sessions 포함)
    _create_sqlite_db(data_dir / "soulstream.db")

    # events/ — SessionCache 실제 포맷: {"id": N, "event": {...}}
    events_dir = data_dir / "events"
    events_dir.mkdir()
    (events_dir / "sess-1.jsonl").write_text(
        json.dumps({"id": 1, "event": {"type": "text", "text": "hello"}}) + "\n"
        + json.dumps({"id": 2, "event": {"type": "tool_use", "input": "test"}}) + "\n",
        encoding="utf-8",
    )
    (events_dir / "sess-2.jsonl").write_text(
        json.dumps({"id": 1, "event": {"type": "user_message", "text": "hi"}}) + "\n",
        encoding="utf-8",
    )

    return data_dir


def _make_mock_pool():
    """asyncpg.Pool을 모방하는 mock."""
    conn = AsyncMock()

    class _AcquireCtx:
        async def __aenter__(self):
            return conn

        async def __aexit__(self, *args):
            pass

    pool = MagicMock()
    pool.acquire.return_value = _AcquireCtx()

    return pool, conn


def _make_mock_session_db(pool: AsyncMock, node_id: str = "test-node") -> MagicMock:
    """PostgresSessionDB를 모방."""
    db = MagicMock()
    db.pool = pool
    db.node_id = node_id
    return db


# ---------------------------------------------------------------------------
# _detect_legacy_files
# ---------------------------------------------------------------------------


class TestDetectLegacyFiles:
    def test_no_legacy_files(self, data_dir: Path):
        result = _detect_legacy_files(str(data_dir))
        assert result == {}

    def test_all_files_present(self, populated_data_dir: Path):
        result = _detect_legacy_files(str(populated_data_dir))
        assert "sessions_db" in result
        assert "events_dir" in result

    def test_skips_deprecated(self, data_dir: Path):
        """이미 .deprecated 접미사가 붙은 파일은 감지하지 않는다."""
        (data_dir / "soulstream.db.deprecated").write_text("")
        (data_dir / "events.deprecated").mkdir()

        result = _detect_legacy_files(str(data_dir))
        assert result == {}

    def test_partial_files(self, data_dir: Path):
        """일부 파일만 존재할 때."""
        (data_dir / "soulstream.db").write_text("")
        result = _detect_legacy_files(str(data_dir))
        assert "sessions_db" in result
        assert "events_dir" not in result


# ---------------------------------------------------------------------------
# _count_sources
# ---------------------------------------------------------------------------


class TestCountSources:
    def test_sessions_count(self, populated_data_dir: Path):
        legacy = _detect_legacy_files(str(populated_data_dir))
        counts = _count_sources(legacy)
        assert counts["sessions"] == 3

    def test_events_count(self, populated_data_dir: Path):
        """이벤트 수는 SQLite events 테이블 + JSONL 행 수 합계."""
        legacy = _detect_legacy_files(str(populated_data_dir))
        counts = _count_sources(legacy)
        assert counts["events"] == 6  # SQLite: 3 + JSONL: 3

    def test_folders_count(self, populated_data_dir: Path):
        """사용자 정의 폴더만 카운트 (시스템 폴더 제외)."""
        legacy = _detect_legacy_files(str(populated_data_dir))
        counts = _count_sources(legacy)
        assert counts["folders"] == 2  # "내 작업", "소울스트림"

    def test_empty_legacy(self):
        counts = _count_sources({})
        assert counts == {"folders": 0, "sessions": 0, "events": 0}


# ---------------------------------------------------------------------------
# _is_system_folder / _map_folder_id
# ---------------------------------------------------------------------------


class TestFolderHelpers:
    def test_system_folder_claude(self):
        assert _is_system_folder("uuid-1", "⚙️ 클로드 코드 세션") is True

    def test_system_folder_llm(self):
        assert _is_system_folder("uuid-2", "⚙️ LLM 세션") is True

    def test_system_folder_by_id(self):
        assert _is_system_folder("claude", "anything") is True
        assert _is_system_folder("llm", "anything") is True

    def test_user_folder(self):
        assert _is_system_folder("custom-1", "내 작업") is False

    def test_map_claude(self):
        assert _map_folder_id("uuid-1", "⚙️ 클로드 코드 세션") == "claude"

    def test_map_llm(self):
        assert _map_folder_id("uuid-2", "⚙️ LLM 세션") == "llm"

    def test_map_custom(self):
        assert _map_folder_id("custom-1", "내 작업") == "custom-1"


# ---------------------------------------------------------------------------
# _verify_migration
# ---------------------------------------------------------------------------


class TestVerifyMigration:
    @pytest.mark.asyncio
    async def test_success(self):
        pool, conn = _make_mock_pool()
        conn.fetchrow = AsyncMock(return_value={
            "session_count": 10, "event_count": 50, "folder_count": 2,
        })
        source = {"sessions": 10, "events": 50, "folders": 2}
        assert await _verify_migration(pool, source, "node-1") is True
        conn.fetchrow.assert_awaited_once()
        call_args = conn.fetchrow.await_args
        assert "migration_verify" in call_args.args[0]

    @pytest.mark.asyncio
    async def test_failure_sessions(self):
        pool, conn = _make_mock_pool()
        conn.fetchrow = AsyncMock(return_value={
            "session_count": 5, "event_count": 50, "folder_count": 2,
        })
        source = {"sessions": 10, "events": 50, "folders": 2}
        assert await _verify_migration(pool, source, "node-1") is False

    @pytest.mark.asyncio
    async def test_ge_comparison(self):
        """PG 레코드 수가 원본보다 많아도 통과."""
        pool, conn = _make_mock_pool()
        conn.fetchrow = AsyncMock(return_value={
            "session_count": 15, "event_count": 100, "folder_count": 5,
        })
        source = {"sessions": 10, "events": 50, "folders": 2}
        assert await _verify_migration(pool, source, "node-1") is True


# ---------------------------------------------------------------------------
# _deprecate_files
# ---------------------------------------------------------------------------


class TestDeprecateFiles:
    def test_renames_files(self, populated_data_dir: Path):
        legacy = _detect_legacy_files(str(populated_data_dir))
        _deprecate_files(legacy)

        assert (populated_data_dir / "soulstream.db.deprecated").exists()
        assert (populated_data_dir / "events.deprecated").exists()
        assert not (populated_data_dir / "soulstream.db").exists()
        assert not (populated_data_dir / "events").exists()

    def test_skips_if_deprecated_exists(self, data_dir: Path):
        """이미 .deprecated 파일이 있으면 원본을 리네이밍하지 않는다."""
        (data_dir / "soulstream.db").write_text("")
        (data_dir / "soulstream.db.deprecated").write_text("old")

        legacy = {"sessions_db": data_dir / "soulstream.db"}
        _deprecate_files(legacy)
        assert (data_dir / "soulstream.db").exists()  # 리네이밍 안 함


# ---------------------------------------------------------------------------
# auto_migrate 통합
# ---------------------------------------------------------------------------


class TestAutoMigrate:
    @pytest.mark.asyncio
    async def test_no_legacy_files(self, data_dir: Path):
        """레거시 파일 없으면 즉시 리턴, DB 호출 없음."""
        pool, conn = _make_mock_pool()
        session_db = _make_mock_session_db(pool)

        await auto_migrate(session_db, str(data_dir))
        conn.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_error_isolation(self, populated_data_dir: Path):
        """이관 중 예외 발생 시 함수가 정상 종료된다."""
        session_db = MagicMock()
        session_db.node_id = "test"
        # pool 접근 시 예외
        type(session_db).pool = property(lambda self: (_ for _ in ()).throw(RuntimeError("boom")))

        # 예외가 전파되지 않아야 한다
        await auto_migrate(session_db, str(populated_data_dir))

    @pytest.mark.asyncio
    async def test_idempotent(self, populated_data_dir: Path):
        """검증 통과 후 deprecated 처리되면, 두 번째 실행에서 감지 안 함."""
        pool, conn = _make_mock_pool()
        # migration_verify 결과
        conn.fetchrow = AsyncMock(return_value={
            "session_count": 3, "event_count": 6, "folder_count": 2,
        })
        session_db = _make_mock_session_db(pool)

        await auto_migrate(session_db, str(populated_data_dir))

        # soulstream.db와 events/ 모두 deprecated 처리됨 확인
        assert (populated_data_dir / "soulstream.db.deprecated").exists()
        assert (populated_data_dir / "events.deprecated").exists()

        # 두 번째 실행: deprecated 파일만 있으므로 감지 안 함 → 즉시 리턴
        conn.execute.reset_mock()
        await auto_migrate(session_db, str(populated_data_dir))
        conn.execute.assert_not_awaited()


# ---------------------------------------------------------------------------
# 헬퍼 함수 테스트
# ---------------------------------------------------------------------------


class TestParsedt:
    def test_none(self):
        dt = _parse_dt(None)
        assert dt.tzinfo is not None

    def test_iso_string(self):
        dt = _parse_dt("2026-01-01T12:00:00Z")
        assert dt.year == 2026

    def test_invalid(self):
        dt = _parse_dt("not-a-date")
        assert dt.tzinfo is not None


class TestExtractSearchable:
    def test_text(self):
        assert _extract_searchable({"type": "text", "text": "hello"}) == "hello"

    def test_tool_use_string(self):
        assert _extract_searchable({"type": "tool_use", "input": "cmd"}) == "cmd"

    def test_tool_use_dict(self):
        result = _extract_searchable({"type": "tool_use", "input": {"key": "val"}})
        assert "key" in result

    def test_unknown_type(self):
        assert _extract_searchable({"type": "unknown_type"}) == ""


# ---------------------------------------------------------------------------
# JSONL 포맷 호환성 테스트
# ---------------------------------------------------------------------------


def _extract_event_records(conn):
    """executemany 호출에서 migration_insert_event 레코드를 추출한다.

    executemany(query, records) 형태로 호출되므로,
    records 리스트의 각 튜플은 (sid, eid, event_type, payload, searchable, created_at).
    개별 폴백으로 conn.execute가 호출될 수도 있으므로 양쪽 모두 수집한다.
    """
    records = []
    # executemany 배치 호출에서 수집
    for call in conn.executemany.await_args_list:
        query = call.args[0]
        if "migration_insert_event" in str(query):
            records.extend(call.args[1])
    # 개별 폴백 execute 호출에서 수집
    for call in conn.execute.await_args_list:
        if "migration_insert_event" in str(call.args[0]):
            # execute(query, sid, eid, event_type, payload, searchable, created_at)
            records.append(call.args[1:])
    return records


class TestJsonlFormatCompat:
    """nested/flat/mixed JSONL 포맷이 올바르게 파싱되는지 검증."""

    @pytest.mark.asyncio
    async def test_nested_event_format(self, data_dir: Path):
        """SessionCache 포맷 {"id": N, "event": {...}}이 올바르게 파싱된다."""
        events_dir = data_dir / "events"
        events_dir.mkdir()
        (events_dir / "sess-nested.jsonl").write_text(
            json.dumps({"id": 1, "event": {"type": "text", "text": "hello world"}}) + "\n"
            + json.dumps({"id": 2, "event": {"type": "tool_use", "input": "test cmd"}}) + "\n",
            encoding="utf-8",
        )

        pool, conn = _make_mock_pool()

        from soul_server.service.legacy_migrator import _migrate_events_from_jsonl
        await _migrate_events_from_jsonl(pool, events_dir, "test-node")

        # executemany/execute에서 이벤트 레코드 추출
        # 레코드 튜플: (sid, eid, event_type, payload, searchable, created_at)
        records = _extract_event_records(conn)
        assert len(records) == 2

        # 첫 번째 이벤트: event_type이 "text"여야 함 (not "unknown")
        first = records[0]
        assert first[2] == "text"  # event_type
        assert first[4] == "hello world"  # searchable_text
        # payload에 래퍼 없이 이벤트만 포함
        payload_dict = json.loads(first[3])
        assert "event" not in payload_dict  # 래퍼 없음
        assert payload_dict["type"] == "text"

        # 두 번째 이벤트
        second = records[1]
        assert second[2] == "tool_use"
        assert second[4] == "test cmd"

        # migration_ensure_session 호출 확인
        calls = conn.execute.await_args_list
        ensure_calls = [
            c for c in calls
            if "migration_ensure_session" in str(c.args[0])
        ]
        assert len(ensure_calls) == 1

        # migration_update_last_event_id 호출 확인
        update_calls = [
            c for c in calls
            if "migration_update_last_event_id" in str(c.args[0])
        ]
        assert len(update_calls) == 1

    @pytest.mark.asyncio
    async def test_flat_event_format_compat(self, data_dir: Path):
        """레거시 flat 포맷 {"id": N, "type": "...", ...}도 여전히 호환된다."""
        events_dir = data_dir / "events"
        events_dir.mkdir()
        (events_dir / "sess-flat.jsonl").write_text(
            json.dumps({"id": 1, "type": "text", "text": "flat hello"}) + "\n",
            encoding="utf-8",
        )

        pool, conn = _make_mock_pool()

        from soul_server.service.legacy_migrator import _migrate_events_from_jsonl
        await _migrate_events_from_jsonl(pool, events_dir, "test-node")

        records = _extract_event_records(conn)
        assert len(records) == 1
        assert records[0][2] == "text"
        assert records[0][4] == "flat hello"

    @pytest.mark.asyncio
    async def test_mixed_format(self, data_dir: Path):
        """한 파일에 nested와 flat이 섞여 있어도 정상 처리된다."""
        events_dir = data_dir / "events"
        events_dir.mkdir()
        (events_dir / "sess-mixed.jsonl").write_text(
            json.dumps({"id": 1, "event": {"type": "text", "text": "nested"}}) + "\n"
            + json.dumps({"id": 2, "type": "user_message", "text": "flat"}) + "\n",
            encoding="utf-8",
        )

        pool, conn = _make_mock_pool()

        from soul_server.service.legacy_migrator import _migrate_events_from_jsonl
        await _migrate_events_from_jsonl(pool, events_dir, "test-node")

        records = _extract_event_records(conn)
        assert len(records) == 2
        assert records[0][2] == "text"
        assert records[0][4] == "nested"
        assert records[1][2] == "user_message"
        assert records[1][4] == "flat"


# ---------------------------------------------------------------------------
# 드라이런 테스트
# ---------------------------------------------------------------------------


class TestDryRun:
    @pytest.mark.asyncio
    async def test_dry_run_no_db_writes(self, populated_data_dir: Path):
        """dry_run=True일 때 DB INSERT가 호출되지 않는다."""
        pool, conn = _make_mock_pool()
        session_db = _make_mock_session_db(pool)

        report = await auto_migrate(session_db, str(populated_data_dir), dry_run=True)

        assert isinstance(report, DryRunReport)
        conn.execute.assert_not_awaited()
        conn.executemany.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_dry_run_no_deprecate(self, populated_data_dir: Path):
        """dry_run=True일 때 원본 파일이 deprecated되지 않는다."""
        pool, conn = _make_mock_pool()
        session_db = _make_mock_session_db(pool)

        await auto_migrate(session_db, str(populated_data_dir), dry_run=True)

        assert (populated_data_dir / "soulstream.db").exists()
        assert (populated_data_dir / "events").exists()
        assert not (populated_data_dir / "soulstream.db.deprecated").exists()
        assert not (populated_data_dir / "events.deprecated").exists()

    @pytest.mark.asyncio
    async def test_dry_run_report_contents(self, populated_data_dir: Path):
        """DryRunReport에 올바른 정보가 담긴다."""
        report = await auto_migrate_dry_run(str(populated_data_dir))

        assert report is not None
        assert report.source_counts["sessions"] == 3
        assert report.source_counts["events"] == 6  # SQLite: 3 + JSONL: 3
        assert report.source_counts["folders"] == 2
        assert "sessions_db" in report.legacy_files
        assert "events_dir" in report.legacy_files
        # 이벤트 타입 분포 검증
        assert "text" in report.event_type_distribution
        assert "tool_use" in report.event_type_distribution
        assert "user_message" in report.event_type_distribution
        # 샘플 매핑 검증
        assert len(report.sample_mappings) > 0
        assert len(report.sample_mappings) <= 3
        for s in report.sample_mappings:
            assert "session_id" in s
            assert "event_id" in s
            assert "event_type" in s

    @pytest.mark.asyncio
    async def test_dry_run_no_legacy_files(self, data_dir: Path):
        """레거시 파일이 없으면 None을 반환한다."""
        report = await auto_migrate_dry_run(str(data_dir))
        assert report is None

    @pytest.mark.asyncio
    async def test_dry_run_sessions_to_create(self, data_dir: Path):
        """SQLite에 없는 JSONL 세션이 sessions_to_create에 포함된다."""
        # JSONL만 있고 SQLite 없음 → 모든 JSONL 세션이 자동 생성 대상
        events_dir = data_dir / "events"
        events_dir.mkdir()
        (events_dir / "sess-orphan.jsonl").write_text(
            json.dumps({"id": 1, "event": {"type": "text", "text": "orphan"}}) + "\n",
            encoding="utf-8",
        )

        report = await auto_migrate_dry_run(str(data_dir))
        assert report is not None
        assert "sess-orphan" in report.sessions_to_create
