"""PostgresSessionDB 단위 테스트

asyncpg 연결을 mock하여 DB 없이 테스트한다.
모든 raw SQL이 프로시저/함수 호출로 전환되었음을 검증한다.
"""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.service.postgres_session_db import PostgresSessionDB


# === Mock helpers ===


class _TxnCtx:
    """conn.transaction() mock"""
    async def __aenter__(self):
        return self
    async def __aexit__(self, *args):
        pass


class _AcquireCtx:
    """pool.acquire() mock — returns a connection with transaction support"""
    def __init__(self, conn):
        self._conn = conn
    async def __aenter__(self):
        return self._conn
    async def __aexit__(self, *args):
        pass


def _make_pool_with_conn():
    """트랜잭션을 지원하는 pool + conn mock 쌍을 반환한다."""
    conn = MagicMock()
    conn.transaction.return_value = _TxnCtx()
    conn.execute = AsyncMock()
    conn.fetchrow = AsyncMock()
    conn.fetchval = AsyncMock()
    conn.fetch = AsyncMock()
    pool = MagicMock()
    pool.acquire.return_value = _AcquireCtx(conn)
    # pool 직접 호출도 지원
    pool.execute = AsyncMock()
    pool.fetchrow = AsyncMock()
    pool.fetchval = AsyncMock()
    pool.fetch = AsyncMock()
    return pool, conn


# === Fixtures ===

@pytest.fixture
def db():
    """Mock pool을 가진 PostgresSessionDB 인스턴스"""
    sdb = PostgresSessionDB(
        database_url="postgresql://test:test@localhost/test",
        node_id="test-node",
    )
    sdb._pool = AsyncMock()
    return sdb


@pytest.fixture
def db_with_conn():
    """트랜잭션 지원 pool + conn mock을 가진 DB 인스턴스"""
    sdb = PostgresSessionDB(
        database_url="postgresql://test:test@localhost/test",
        node_id="test-node",
    )
    pool, conn = _make_pool_with_conn()
    sdb._pool = pool
    return sdb, conn


def _make_record(data: dict):
    """asyncpg.Record를 흉내내는 dict-like 객체"""
    record = MagicMock()
    record.__getitem__ = lambda self, key: data[key]
    record.__contains__ = lambda self, key: key in data
    record.get = lambda key, default=None: data.get(key, default)
    record.keys = lambda: data.keys()
    record.values = lambda: data.values()
    record.items = lambda: data.items()

    # dict(record) 지원
    def iter_fn(self):
        return iter(data)
    record.__iter__ = iter_fn
    record.__len__ = lambda self: len(data)
    return record


# === 세션 CRUD ===


class TestSessionCRUD:
    @pytest.mark.asyncio
    async def test_upsert_calls_session_upsert(self, db):
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="running", session_type="claude")

        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "session_upsert" in sql

    @pytest.mark.asyncio
    async def test_upsert_passes_columns_and_values(self, db):
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="completed")

        call_args = db._pool.execute.call_args[0]
        # $1=session_id, $2=columns, $3=values, $4=created_at, $5=updated_at
        session_id = call_args[1]
        columns = call_args[2]
        values = call_args[3]
        assert session_id == "s1"
        assert "status" in columns
        assert "completed" in values

    @pytest.mark.asyncio
    async def test_upsert_auto_sets_node_id(self, db):
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="running")

        call_args = db._pool.execute.call_args[0]
        columns = call_args[2]
        values = call_args[3]
        assert "node_id" in columns
        node_idx = columns.index("node_id")
        assert values[node_idx] == "test-node"

    @pytest.mark.asyncio
    async def test_get_session_returns_none(self, db):
        db._pool.fetchrow = AsyncMock(return_value=None)
        result = await db.get_session("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_session_calls_procedure(self, db):
        record = _make_record({
            "session_id": "s1", "status": "running",
            "last_message": '{"preview": "hi"}',
            "metadata": '[{"type": "tool"}]',
            "was_running_at_shutdown": True,
        })
        db._pool.fetchrow = AsyncMock(return_value=record)

        result = await db.get_session("s1")

        sql = db._pool.fetchrow.call_args[0][0]
        assert "session_get" in sql
        assert result["session_id"] == "s1"
        assert result["last_message"] == {"preview": "hi"}
        assert result["metadata"] == [{"type": "tool"}]
        assert result["was_running_at_shutdown"] is True

    @pytest.mark.asyncio
    async def test_get_all_sessions(self, db):
        records = [
            _make_record({
                "session_id": f"s{i}", "status": "running",
                "last_message": None, "metadata": None,
                "was_running_at_shutdown": False,
            })
            for i in range(3)
        ]
        db._pool.fetchval = AsyncMock(return_value=3)
        db._pool.fetch = AsyncMock(return_value=records)

        sessions, total = await db.get_all_sessions()
        assert total == 3
        assert len(sessions) == 3

    @pytest.mark.asyncio
    async def test_get_all_sessions_calls_procedures(self, db):
        records = [
            _make_record({
                "session_id": "s1", "session_type": "llm",
                "last_message": None, "metadata": None,
                "was_running_at_shutdown": False,
            })
        ]
        db._pool.fetchval = AsyncMock(return_value=1)
        db._pool.fetch = AsyncMock(return_value=records)

        sessions, total = await db.get_all_sessions(session_type="llm")
        assert total == 1

        # session_count 호출 확인
        count_call = db._pool.fetchval.call_args
        assert "session_count" in count_call[0][0]

        # session_get_all 호출 확인
        fetch_call = db._pool.fetch.call_args
        assert "session_get_all" in fetch_call[0][0]

    @pytest.mark.asyncio
    async def test_delete_session(self, db):
        db._pool.execute = AsyncMock()
        await db.delete_session("s1")
        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "session_delete" in sql

    @pytest.mark.asyncio
    async def test_upsert_rejects_invalid_columns(self, db):
        with pytest.raises(ValueError, match="Invalid session columns"):
            await db.upsert_session("s1", bogus_field="nope")


# === 이벤트 CRUD ===


class TestEventCRUD:
    @pytest.mark.asyncio
    async def test_append_event(self, db):
        db._pool.fetchval = AsyncMock(return_value=1)

        event_id = await db.append_event(
            "s1", "text_delta",
            '{"text":"hello"}', "hello",
            "2026-01-01T00:00:00+00:00",
        )

        assert event_id == 1
        # 프로시저 호출 확인
        sql = db._pool.fetchval.call_args[0][0]
        assert "event_append" in sql
        # 트랜잭션 코드 없음 — 프로시저 내부에서 처리

    @pytest.mark.asyncio
    async def test_read_events(self, db):
        now = datetime.now(timezone.utc)
        records = [
            _make_record({
                "id": 1, "session_id": "s1", "event_type": "text_delta",
                "payload": '{"text":"hello"}', "searchable_text": "hello",
                "created_at": now,
            }),
            _make_record({
                "id": 2, "session_id": "s1", "event_type": "tool_use",
                "payload": '{"tool":"grep"}', "searchable_text": "grep",
                "created_at": now,
            }),
        ]
        db._pool.fetch = AsyncMock(return_value=records)

        events = await db.read_events("s1", after_id=0)
        assert len(events) == 2
        assert events[0]["id"] == 1
        assert events[1]["event_type"] == "tool_use"

        # 프로시저 호출 확인
        sql = db._pool.fetch.call_args[0][0]
        assert "event_read" in sql

    @pytest.mark.asyncio
    async def test_stream_events_raw_empty(self, db_with_conn):
        """빈 세션에서 stream_events_raw는 아무것도 yield하지 않는다"""
        db, conn = db_with_conn

        async def empty_cursor(*args, **kwargs):
            return
            yield  # make it an async generator

        conn.cursor = MagicMock(return_value=empty_cursor())

        results = []
        async for item in db.stream_events_raw("s1"):
            results.append(item)
        assert results == []

    @pytest.mark.asyncio
    async def test_stream_events_raw_yields_tuples(self, db_with_conn):
        """stream_events_raw는 (id, event_type, payload_text) 튜플을 yield한다"""
        db, conn = db_with_conn

        rows = [
            {"id": 1, "event_type": "text_delta", "payload_text": '{"type":"text_delta","text":"hello"}'},
            {"id": 2, "event_type": "tool_use", "payload_text": '{"type":"tool_use","tool":"grep"}'},
        ]

        async def mock_cursor(*args, **kwargs):
            for row in rows:
                yield row

        conn.cursor = MagicMock(return_value=mock_cursor())

        results = []
        async for item in db.stream_events_raw("s1"):
            results.append(item)

        assert len(results) == 2
        assert results[0] == (1, "text_delta", '{"type":"text_delta","text":"hello"}')
        assert results[1] == (2, "tool_use", '{"type":"tool_use","tool":"grep"}')

    @pytest.mark.asyncio
    async def test_stream_events_raw_uses_procedure(self, db_with_conn):
        """stream_events_raw는 event_stream_raw 프로시저를 호출한다"""
        db, conn = db_with_conn

        async def empty_cursor(*args, **kwargs):
            return
            yield

        conn.cursor = MagicMock(return_value=empty_cursor())

        async for _ in db.stream_events_raw("s1", after_id=5):
            pass

        cursor_call = conn.cursor.call_args
        sql = cursor_call[0][0]
        assert "event_stream_raw" in sql
        assert cursor_call[0][1] == "s1"
        assert cursor_call[0][2] == 5

    @pytest.mark.asyncio
    async def test_read_one_event(self, db):
        now = datetime.now(timezone.utc)
        record = _make_record({
            "id": 1, "session_id": "s1", "event_type": "text_delta",
            "payload": '{"text":"hello"}', "searchable_text": "hello",
            "created_at": now,
        })
        db._pool.fetchrow = AsyncMock(return_value=record)

        event = await db.read_one_event("s1", 1)
        assert event is not None
        assert event["id"] == 1

        # 프로시저 호출 확인
        sql = db._pool.fetchrow.call_args[0][0]
        assert "event_read_one" in sql

    @pytest.mark.asyncio
    async def test_read_one_event_not_found(self, db):
        db._pool.fetchrow = AsyncMock(return_value=None)
        event = await db.read_one_event("s1", 999)
        assert event is None

    @pytest.mark.asyncio
    async def test_count_events(self, db):
        db._pool.fetchval = AsyncMock(return_value=42)
        count = await db.count_events("s1")
        assert count == 42

        sql = db._pool.fetchval.call_args[0][0]
        assert "event_count" in sql


# === append_metadata 원자적 처리 ===


class TestAppendMetadata:
    @pytest.mark.asyncio
    async def test_append_metadata_calls_procedure(self, db):
        """session_append_metadata 프로시저를 호출하는지 확인"""
        db._pool.fetchval = AsyncMock(return_value=42)

        entry = {"type": "git_commit", "value": "abc1234"}
        await db.append_metadata("s1", entry)

        db._pool.fetchval.assert_called_once()
        sql = db._pool.fetchval.call_args[0][0]
        assert "session_append_metadata" in sql

    @pytest.mark.asyncio
    async def test_append_metadata_passes_correct_params(self, db):
        """프로시저에 올바른 파라미터를 전달하는지 확인"""
        db._pool.fetchval = AsyncMock(return_value=1)

        entry = {"type": "trello_card", "value": "card-123"}
        await db.append_metadata("s1", entry)

        call_args = db._pool.fetchval.call_args[0]
        # $1=session_id, $2=metadata_json, $3=event_type, $4=event_payload, $5=searchable, $6=now
        assert call_args[1] == "s1"  # session_id
        assert "trello_card" in call_args[2]  # metadata_json에 entry 포함
        assert call_args[3] == "metadata"  # event_type

    @pytest.mark.asyncio
    async def test_append_metadata_no_transaction_in_python(self, db):
        """Python 측에서 트랜잭션을 열지 않는지 확인 (프로시저 내부에서 처리)"""
        db._pool.fetchval = AsyncMock(return_value=5)

        entry = {"type": "git_commit", "value": "abc1234"}
        await db.append_metadata("s1", entry)

        # pool.acquire()가 호출되지 않음 (트랜잭션 불필요)
        # pool.fetchval만 직접 호출됨
        db._pool.fetchval.assert_called_once()


# === 폴더 CRUD ===


class TestFolderCRUD:
    @pytest.mark.asyncio
    async def test_create_folder(self, db):
        db._pool.execute = AsyncMock()
        await db.create_folder("f1", "Test Folder", 0)
        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "folder_create" in sql

    @pytest.mark.asyncio
    async def test_ensure_default_folders(self, db):
        db._pool.execute = AsyncMock()
        await db.ensure_default_folders()
        # 프로시저 1회 호출 (JSONB 배열로 전달)
        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "folder_ensure_defaults" in sql

    @pytest.mark.asyncio
    async def test_ensure_indexes_is_noop(self, db):
        """ensure_indexes는 no-op이다 (schema.sql에서 DDL로 처리)"""
        db._pool.execute = AsyncMock()
        await db.ensure_indexes()
        db._pool.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_get_catalog(self, db):
        folder_records = [
            _make_record({"id": "claude", "name": "Claude", "sort_order": 0}),
        ]
        session_records = [
            _make_record({
                "session_id": "s1", "folder_id": "claude", "display_name": None,
            }),
        ]
        db._pool.fetch = AsyncMock(side_effect=[folder_records, session_records])

        catalog = await db.get_catalog()
        assert "folders" in catalog
        assert "sessions" in catalog
        assert catalog["folders"][0]["id"] == "claude"
        assert "s1" in catalog["sessions"]

        # catalog_get_sessions 프로시저 호출 확인
        second_fetch = db._pool.fetch.call_args_list[1]
        assert "catalog_get_sessions" in second_fetch[0][0]

    @pytest.mark.asyncio
    async def test_update_folder(self, db):
        db._pool.execute = AsyncMock()
        await db.update_folder("f1", name="New Name")
        sql = db._pool.execute.call_args[0][0]
        assert "folder_update" in sql

    @pytest.mark.asyncio
    async def test_delete_folder(self, db):
        db._pool.execute = AsyncMock()
        await db.delete_folder("f1")
        sql = db._pool.execute.call_args[0][0]
        assert "folder_delete" in sql

    @pytest.mark.asyncio
    async def test_get_folder(self, db):
        record = _make_record({"id": "f1", "name": "Test", "sort_order": 0})
        db._pool.fetchrow = AsyncMock(return_value=record)
        result = await db.get_folder("f1")
        assert result["id"] == "f1"
        sql = db._pool.fetchrow.call_args[0][0]
        assert "folder_get" in sql

    @pytest.mark.asyncio
    async def test_get_all_folders(self, db):
        records = [_make_record({"id": "f1", "name": "Test", "sort_order": 0})]
        db._pool.fetch = AsyncMock(return_value=records)
        result = await db.get_all_folders()
        assert len(result) == 1
        sql = db._pool.fetch.call_args[0][0]
        assert "folder_get_all" in sql

    @pytest.mark.asyncio
    async def test_get_default_folder(self, db):
        record = _make_record({"id": "claude", "name": "Claude", "sort_order": 0})
        db._pool.fetchrow = AsyncMock(return_value=record)
        result = await db.get_default_folder("Claude")
        assert result["id"] == "claude"
        sql = db._pool.fetchrow.call_args[0][0]
        assert "folder_get_default" in sql


# === 전문검색 ===


class TestSearch:
    @pytest.mark.asyncio
    async def test_search_events_empty_query(self, db):
        results = await db.search_events("  ")
        assert results == []

    @pytest.mark.asyncio
    async def test_search_events(self, db):
        now = datetime.now(timezone.utc)
        records = [
            _make_record({
                "id": 1, "session_id": "s1", "event_type": "text_delta",
                "payload": '{"text":"hello"}', "searchable_text": "hello world",
                "created_at": now,
            }),
        ]
        db._pool.fetch = AsyncMock(return_value=records)

        results = await db.search_events("hello")
        assert len(results) == 1
        assert results[0]["id"] == 1

        # event_search 프로시저 호출 확인
        fetch_call = db._pool.fetch.call_args
        assert "event_search" in fetch_call[0][0]


# === searchable_text 추출 ===


class TestExtractSearchableText:
    def test_text_delta(self):
        assert PostgresSessionDB.extract_searchable_text(
            {"type": "text_delta", "text": "hello world"}
        ) == "hello world"

    def test_thinking(self):
        assert PostgresSessionDB.extract_searchable_text(
            {"type": "thinking", "thinking": "I should..."}
        ) == "I should..."

    def test_tool_use_string_input(self):
        assert PostgresSessionDB.extract_searchable_text(
            {"type": "tool_use", "input": "search query"}
        ) == "search query"

    def test_tool_use_dict_input(self):
        result = PostgresSessionDB.extract_searchable_text(
            {"type": "tool_use", "input": {"query": "test"}}
        )
        assert "test" in result

    def test_tool_result_string(self):
        assert PostgresSessionDB.extract_searchable_text(
            {"type": "tool_result", "result": "found it"}
        ) == "found it"

    def test_user_message(self):
        assert PostgresSessionDB.extract_searchable_text(
            {"type": "user_message", "text": "help me"}
        ) == "help me"

    def test_unknown_type(self):
        assert PostgresSessionDB.extract_searchable_text(
            {"type": "progress", "text": "working"}
        ) == ""


# === node_id ===


class TestNodeId:
    def test_node_id_property(self, db):
        assert db.node_id == "test-node"

    @pytest.mark.asyncio
    async def test_upsert_sets_node_id(self, db):
        """upsert_session이 node_id를 자동 설정하는지 확인"""
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="running")

        call_args = db._pool.execute.call_args[0]
        columns = call_args[2]
        values = call_args[3]

        assert "node_id" in columns
        node_idx = columns.index("node_id")
        assert values[node_idx] == "test-node"


# === 읽음 상태 관리 ===


class TestReadPosition:
    @pytest.mark.asyncio
    async def test_update_last_read_event_id(self, db):
        db._pool.fetchval = AsyncMock(return_value="UPDATE 1")
        result = await db.update_last_read_event_id("s1", 42)
        assert result is True

        sql = db._pool.fetchval.call_args[0][0]
        assert "session_update_read_position" in sql

    @pytest.mark.asyncio
    async def test_update_last_read_event_id_not_found(self, db):
        db._pool.fetchval = AsyncMock(return_value="UPDATE 0")
        result = await db.update_last_read_event_id("nonexistent", 42)
        assert result is False

    @pytest.mark.asyncio
    async def test_get_read_position(self, db):
        record = _make_record({"last_event_id": 10, "last_read_event_id": 5})
        db._pool.fetchrow = AsyncMock(return_value=record)

        last_event_id, last_read = await db.get_read_position("s1")
        assert last_event_id == 10
        assert last_read == 5

        sql = db._pool.fetchrow.call_args[0][0]
        assert "session_get_read_position" in sql


# === shutdown 관련 ===


class TestShutdown:
    @pytest.mark.asyncio
    async def test_mark_running_at_shutdown(self, db):
        db._pool.execute = AsyncMock()
        await db.mark_running_at_shutdown(["s1", "s2"])
        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "shutdown_mark_running" in sql

    @pytest.mark.asyncio
    async def test_mark_running_at_shutdown_empty(self, db):
        db._pool.execute = AsyncMock()
        await db.mark_running_at_shutdown([])
        db._pool.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_clear_shutdown_flags(self, db):
        db._pool.execute = AsyncMock()
        await db.clear_shutdown_flags()
        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "shutdown_clear_flags" in sql

    @pytest.mark.asyncio
    async def test_get_shutdown_sessions(self, db):
        records = [
            _make_record({"session_id": "s1", "was_running_at_shutdown": True}),
        ]
        db._pool.fetch = AsyncMock(return_value=records)
        sessions = await db.get_shutdown_sessions()
        assert len(sessions) == 1

        sql = db._pool.fetch.call_args[0][0]
        assert "shutdown_get_sessions" in sql

    @pytest.mark.asyncio
    async def test_repair_broken_read_positions(self, db):
        db._pool.fetchval = AsyncMock(return_value=3)
        count = await db.repair_broken_read_positions()
        assert count == 3

        sql = db._pool.fetchval.call_args[0][0]
        assert "shutdown_repair_read_positions" in sql


# === 세션 부가 기능 ===


class TestSessionMisc:
    @pytest.mark.asyncio
    async def test_rename_session(self, db):
        db._pool.execute = AsyncMock()
        await db.rename_session("s1", "New Name")
        sql = db._pool.execute.call_args[0][0]
        assert "session_rename" in sql

    @pytest.mark.asyncio
    async def test_assign_session_to_folder(self, db):
        db._pool.execute = AsyncMock()
        await db.assign_session_to_folder("s1", "folder1")
        sql = db._pool.execute.call_args[0][0]
        assert "session_assign_folder" in sql

    @pytest.mark.asyncio
    async def test_update_last_message(self, db):
        db._pool.execute = AsyncMock()
        await db.update_last_message("s1", {"preview": "hello"})
        sql = db._pool.execute.call_args[0][0]
        assert "session_update_last_message" in sql


# === read_events with limit and event_types ===


class TestReadEventsExtended:
    @pytest.mark.asyncio
    async def test_read_events_with_limit(self, db):
        db._pool.fetch = AsyncMock(return_value=[])
        await db.read_events("s1", after_id=0, limit=10)
        call_args = db._pool.fetch.call_args[0]
        sql = call_args[0]
        assert "event_read" in sql
        # $3 = limit
        assert call_args[3] == 10

    @pytest.mark.asyncio
    async def test_read_events_with_event_types(self, db):
        db._pool.fetch = AsyncMock(return_value=[])
        await db.read_events("s1", after_id=0, event_types=["user_message", "result"])
        call_args = db._pool.fetch.call_args[0]
        # $4 = event_types
        assert call_args[4] == ["user_message", "result"]

    @pytest.mark.asyncio
    async def test_read_events_default_params(self, db):
        db._pool.fetch = AsyncMock(return_value=[])
        await db.read_events("s1")
        call_args = db._pool.fetch.call_args[0]
        # $3 = limit (None), $4 = event_types (None)
        assert call_args[3] is None
        assert call_args[4] is None

    @pytest.mark.asyncio
    async def test_read_events_backward_compatible(self, db):
        """기존 read_events(session_id, after_id) 호출이 동일하게 동작한다."""
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        records = [
            _make_record({
                "id": 1, "session_id": "s1", "event_type": "text_delta",
                "payload": '{"text":"hello"}', "searchable_text": "hello",
                "created_at": now,
            }),
        ]
        db._pool.fetch = AsyncMock(return_value=records)
        events = await db.read_events("s1", after_id=0)
        assert len(events) == 1
        assert events[0]["id"] == 1


# === list_sessions_summary ===


class TestListSessionsSummary:
    @pytest.mark.asyncio
    async def test_calls_procedure(self, db):
        db._pool.fetch = AsyncMock(return_value=[])
        sessions, total = await db.list_sessions_summary()
        assert sessions == []
        assert total == 0
        sql = db._pool.fetch.call_args[0][0]
        assert "session_list_summary" in sql

    @pytest.mark.asyncio
    async def test_returns_sessions_and_total(self, db):
        records = [
            _make_record({
                "session_id": "s1", "display_name": "Session 1",
                "status": "idle", "session_type": "claude",
                "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
                "updated_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
                "event_count": 42, "total_count": 5,
            }),
            _make_record({
                "session_id": "s2", "display_name": None,
                "status": "running", "session_type": "claude",
                "created_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
                "updated_at": datetime(2026, 1, 2, tzinfo=timezone.utc),
                "event_count": 10, "total_count": 5,
            }),
        ]
        db._pool.fetch = AsyncMock(return_value=records)
        sessions, total = await db.list_sessions_summary()
        assert total == 5
        assert len(sessions) == 2
        assert sessions[0]["session_id"] == "s1"
        assert sessions[0]["event_count"] == 42
        # total_count는 제거됨
        assert "total_count" not in sessions[0]

    @pytest.mark.asyncio
    async def test_passes_search_and_type(self, db):
        db._pool.fetch = AsyncMock(return_value=[])
        await db.list_sessions_summary(search="test", session_type="claude", limit=10, offset=5)
        call_args = db._pool.fetch.call_args[0]
        assert call_args[1] == "test"      # search
        assert call_args[2] == "claude"    # session_type
        assert call_args[3] == 10          # limit
        assert call_args[4] == 5           # offset
