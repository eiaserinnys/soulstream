"""legacy_migrator 모듈 테스트."""

import json
import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.legacy_migrator import (
    _build_session_folder_map,
    _count_sources,
    _deprecate_files,
    _detect_legacy_files,
    _extract_searchable,
    _parse_dt,
    _verify_migration,
    auto_migrate,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """빈 데이터 디렉토리."""
    return tmp_path


@pytest.fixture
def catalog_data() -> dict:
    """샘플 session_catalog.json 데이터."""
    return {
        "folders": [
            {"id": "uuid-claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0},
            {"id": "uuid-llm", "name": "⚙️ LLM 세션", "sort_order": 1},
            {"id": "custom-folder-1", "name": "내 작업", "sort_order": 2},
        ],
        "sessions": {
            "sess-1": {"folder_id": "uuid-claude"},
            "sess-2": {"folder_id": "custom-folder-1"},
            "sess-3": {"folder_id": "unknown-id"},
        },
    }


@pytest.fixture
def populated_data_dir(data_dir: Path, catalog_data: dict) -> Path:
    """레거시 파일이 모두 존재하는 데이터 디렉토리."""
    # session_catalog.json
    (data_dir / "session_catalog.json").write_text(json.dumps(catalog_data), encoding="utf-8")

    # soulstream.db
    db_path = data_dir / "soulstream.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, status TEXT, "
        "session_type TEXT, last_message TEXT, metadata TEXT, "
        "created_at TEXT, updated_at TEXT)"
    )
    conn.execute(
        "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("sess-1", "completed", "claude", None, None, "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"),
    )
    conn.execute(
        "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("sess-2", "active", "claude", "hello", None, "2026-01-02T00:00:00Z", "2026-01-02T01:00:00Z"),
    )
    conn.commit()
    conn.close()

    # events/
    events_dir = data_dir / "events"
    events_dir.mkdir()
    (events_dir / "sess-1.jsonl").write_text(
        json.dumps({"id": 1, "type": "text", "text": "hello"}) + "\n"
        + json.dumps({"id": 2, "type": "tool_use", "input": "test"}) + "\n",
        encoding="utf-8",
    )
    (events_dir / "sess-2.jsonl").write_text(
        json.dumps({"id": 1, "type": "user_message", "text": "hi"}) + "\n",
        encoding="utf-8",
    )

    return data_dir


def _make_mock_pool():
    """asyncpg.Pool을 모방하는 mock.

    pool.acquire()가 async context manager를 반환하도록 구성.
    """
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
        assert "catalog" in result
        assert "sessions_db" in result
        assert "events_dir" in result

    def test_skips_deprecated(self, data_dir: Path):
        """이미 .deprecated 접미사가 붙은 파일은 감지하지 않는다."""
        (data_dir / "soulstream.db.deprecated").write_text("")
        (data_dir / "session_catalog.json.deprecated").write_text("{}")
        (data_dir / "events.deprecated").mkdir()

        result = _detect_legacy_files(str(data_dir))
        assert result == {}

    def test_partial_files(self, data_dir: Path):
        """일부 파일만 존재할 때."""
        (data_dir / "soulstream.db").write_text("")
        result = _detect_legacy_files(str(data_dir))
        assert "sessions_db" in result
        assert "catalog" not in result
        assert "events_dir" not in result


# ---------------------------------------------------------------------------
# _count_sources
# ---------------------------------------------------------------------------


class TestCountSources:
    def test_sessions_count(self, populated_data_dir: Path):
        legacy = _detect_legacy_files(str(populated_data_dir))
        counts = _count_sources(legacy)
        assert counts["sessions"] == 2

    def test_events_count(self, populated_data_dir: Path):
        """이벤트 수는 JSONL 행 수 합계이다 (파일 수가 아님)."""
        legacy = _detect_legacy_files(str(populated_data_dir))
        counts = _count_sources(legacy)
        assert counts["events"] == 3  # sess-1: 2행, sess-2: 1행

    def test_catalog_folders_count(self, populated_data_dir: Path):
        """사용자 정의 폴더만 카운트 (시스템 폴더 제외)."""
        legacy = _detect_legacy_files(str(populated_data_dir))
        counts = _count_sources(legacy)
        assert counts["catalog_folders"] == 1  # "내 작업"만

    def test_empty_legacy(self):
        counts = _count_sources({})
        assert counts == {"catalog_folders": 0, "sessions": 0, "events": 0}


# ---------------------------------------------------------------------------
# _build_session_folder_map
# ---------------------------------------------------------------------------


class TestBuildSessionFolderMap:
    def test_maps_system_folders(self, populated_data_dir: Path):
        catalog_path = populated_data_dir / "session_catalog.json"
        sfm = _build_session_folder_map(catalog_path)
        assert sfm["sess-1"] == "claude"  # uuid-claude → claude

    def test_maps_custom_folders(self, populated_data_dir: Path):
        catalog_path = populated_data_dir / "session_catalog.json"
        sfm = _build_session_folder_map(catalog_path)
        assert sfm["sess-2"] == "custom-folder-1"

    def test_unknown_folder_defaults_to_claude(self, populated_data_dir: Path):
        catalog_path = populated_data_dir / "session_catalog.json"
        sfm = _build_session_folder_map(catalog_path)
        assert sfm["sess-3"] == "claude"  # unknown-id → claude

    def test_none_path(self):
        assert _build_session_folder_map(None) == {}


# ---------------------------------------------------------------------------
# _verify_migration
# ---------------------------------------------------------------------------


class TestVerifyMigration:
    @pytest.mark.asyncio
    async def test_success(self):
        pool, conn = _make_mock_pool()
        conn.fetchval = AsyncMock(side_effect=[10, 50, 2])  # sessions, events, folders
        source = {"sessions": 10, "events": 50, "catalog_folders": 2}
        assert await _verify_migration(pool, source, "node-1") is True

    @pytest.mark.asyncio
    async def test_failure_sessions(self):
        pool, conn = _make_mock_pool()
        conn.fetchval = AsyncMock(side_effect=[5, 50, 2])  # sessions 부족
        source = {"sessions": 10, "events": 50, "catalog_folders": 2}
        assert await _verify_migration(pool, source, "node-1") is False

    @pytest.mark.asyncio
    async def test_ge_comparison(self):
        """PG 레코드 수가 원본보다 많아도 통과."""
        pool, conn = _make_mock_pool()
        conn.fetchval = AsyncMock(side_effect=[15, 100, 5])
        source = {"sessions": 10, "events": 50, "catalog_folders": 2}
        assert await _verify_migration(pool, source, "node-1") is True


# ---------------------------------------------------------------------------
# _deprecate_files
# ---------------------------------------------------------------------------


class TestDeprecateFiles:
    def test_renames_files(self, populated_data_dir: Path):
        legacy = _detect_legacy_files(str(populated_data_dir))
        _deprecate_files(legacy)

        assert (populated_data_dir / "soulstream.db.deprecated").exists()
        assert (populated_data_dir / "session_catalog.json.deprecated").exists()
        assert (populated_data_dir / "events.deprecated").exists()
        assert not (populated_data_dir / "soulstream.db").exists()
        assert not (populated_data_dir / "session_catalog.json").exists()
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
        """두 번 실행해도 안전 (ON CONFLICT DO NOTHING)."""
        pool, conn = _make_mock_pool()
        # 검증 통과 → deprecated
        conn.fetchval = AsyncMock(side_effect=[2, 3, 1])
        session_db = _make_mock_session_db(pool)

        await auto_migrate(session_db, str(populated_data_dir))

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
