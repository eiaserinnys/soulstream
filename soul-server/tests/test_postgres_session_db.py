"""PostgresSessionDB 단위 테스트

asyncpg 연결을 mock하여 DB 없이 테스트한다.
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
    async def test_upsert_uses_on_conflict(self, db):
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="running", session_type="claude")

        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "INSERT INTO sessions" in sql
        assert "ON CONFLICT (session_id) DO UPDATE SET" in sql

    @pytest.mark.asyncio
    async def test_upsert_excludes_created_at_from_update(self, db):
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="completed")

        sql = db._pool.execute.call_args[0][0]
        conflict_clause = sql.split("DO UPDATE SET")[1]
        # created_at과 session_id는 ON CONFLICT 절에서 제외
        assert "created_at" not in conflict_clause
        assert "session_id" not in conflict_clause
        # EXCLUDED 참조 사용
        assert "EXCLUDED." in conflict_clause

    @pytest.mark.asyncio
    async def test_upsert_auto_sets_node_id(self, db):
        db._pool.execute = AsyncMock()

        await db.upsert_session("s1", status="running")

        call_args = db._pool.execute.call_args
        sql = call_args[0][0]
        assert "node_id" in sql
        assert "test-node" in [str(a) for a in call_args[0][1:]]

    @pytest.mark.asyncio
    async def test_get_session_returns_none(self, db):
        db._pool.fetchrow = AsyncMock(return_value=None)
        result = await db.get_session("nonexistent")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_session_deserializes(self, db):
        record = _make_record({
            "session_id": "s1", "status": "running",
            "last_message": '{"preview": "hi"}',
            "metadata": '[{"type": "tool"}]',
            "was_running_at_shutdown": True,
        })
        db._pool.fetchrow = AsyncMock(return_value=record)

        result = await db.get_session("s1")
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
    async def test_get_all_sessions_filter_type(self, db):
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

        # Check that filter was included in query
        fetch_call = db._pool.fetch.call_args
        assert "session_type = $1" in fetch_call[0][0]

    @pytest.mark.asyncio
    async def test_delete_session(self, db):
        db._pool.execute = AsyncMock()
        await db.delete_session("s1")
        db._pool.execute.assert_called_once()
        assert "DELETE FROM sessions" in db._pool.execute.call_args[0][0]

    @pytest.mark.asyncio
    async def test_upsert_rejects_invalid_columns(self, db):
        with pytest.raises(ValueError, match="Invalid session columns"):
            await db.upsert_session("s1", bogus_field="nope")


# === 이벤트 CRUD ===


class TestEventCRUD:
    @pytest.mark.asyncio
    async def test_append_event(self, db_with_conn):
        db, conn = db_with_conn

        await db.append_event(
            "s1", 1, "text_delta",
            '{"text":"hello"}', "hello",
            "2026-01-01T00:00:00+00:00",
        )

        # 트랜잭션 내에서 INSERT + UPDATE last_event_id
        assert conn.execute.call_count == 2
        insert_sql = conn.execute.call_args_list[0][0][0]
        update_sql = conn.execute.call_args_list[1][0][0]
        assert "INSERT INTO events" in insert_sql
        assert "last_event_id" in update_sql

    @pytest.mark.asyncio
    async def test_get_next_event_id(self, db):
        record = _make_record({0: 5})
        record.__getitem__ = lambda self, key: 5 if key == 0 else None
        db._pool.fetchrow = AsyncMock(return_value=record)

        next_id = await db.get_next_event_id("s1")
        assert next_id == 5

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
    async def test_stream_events_raw_after_id(self, db_with_conn):
        """stream_events_raw는 after_id를 쿼리에 전달한다"""
        db, conn = db_with_conn

        async def empty_cursor(*args, **kwargs):
            return
            yield

        conn.cursor = MagicMock(return_value=empty_cursor())

        async for _ in db.stream_events_raw("s1", after_id=5):
            pass

        cursor_call = conn.cursor.call_args
        sql = cursor_call[0][0]
        assert "session_id = $1" in sql
        assert "id > $2" in sql
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

    @pytest.mark.asyncio
    async def test_read_one_event_not_found(self, db):
        db._pool.fetchrow = AsyncMock(return_value=None)
        event = await db.read_one_event("s1", 999)
        assert event is None


# === append_metadata 원자적 처리 ===


class TestAppendMetadata:
    @pytest.mark.asyncio
    async def test_append_metadata_uses_transaction(self, db_with_conn):
        """트랜잭션 내에서 JSONB append + 이벤트 삽입이 원자적으로 수행되는지 확인"""
        db, conn = db_with_conn
        conn.execute = AsyncMock(return_value="UPDATE 1")

        entry = {"type": "git_commit", "value": "abc1234"}
        await db.append_metadata("s1", entry)

        # 트랜잭션 내에서 2회 호출: UPDATE sessions + INSERT events
        assert conn.execute.call_count == 2
        update_sql = conn.execute.call_args_list[0][0][0]
        insert_sql = conn.execute.call_args_list[1][0][0]
        assert "COALESCE(metadata" in update_sql
        assert "INSERT INTO events" in insert_sql

    @pytest.mark.asyncio
    async def test_append_metadata_atomic_jsonb_append(self, db_with_conn):
        """SELECT 없이 JSONB || 연산자로 원자적 append하는지 확인"""
        db, conn = db_with_conn
        conn.execute = AsyncMock(return_value="UPDATE 1")

        entry = {"type": "trello_card", "value": "card-123"}
        await db.append_metadata("s1", entry)

        update_sql = conn.execute.call_args_list[0][0][0]
        # JSONB 배열 연결 연산자 사용
        assert "||" in update_sql
        # SELECT로 기존 메타데이터를 먼저 가져오지 않음
        conn.fetchrow = AsyncMock()  # not called

    @pytest.mark.asyncio
    async def test_append_metadata_atomic_event_id(self, db_with_conn):
        """이벤트 ID를 서브쿼리로 원자적으로 계산하는지 확인"""
        db, conn = db_with_conn
        conn.execute = AsyncMock(return_value="UPDATE 1")

        entry = {"type": "git_commit", "value": "abc1234"}
        await db.append_metadata("s1", entry)

        insert_sql = conn.execute.call_args_list[1][0][0]
        # MAX(id) + 1 서브쿼리가 INSERT 안에 포함
        assert "COALESCE(MAX(id), 0) + 1" in insert_sql

    @pytest.mark.asyncio
    async def test_append_metadata_nonexistent_session(self, db_with_conn):
        """존재하지 않는 세션에 append하면 ValueError"""
        db, conn = db_with_conn
        conn.execute = AsyncMock(return_value="UPDATE 0")

        with pytest.raises(ValueError, match="not found"):
            await db.append_metadata("nonexistent", {"type": "test"})


# === 폴더 CRUD ===


class TestFolderCRUD:
    @pytest.mark.asyncio
    async def test_create_folder(self, db):
        db._pool.execute = AsyncMock()
        await db.create_folder("f1", "Test Folder", 0)
        db._pool.execute.assert_called_once()
        assert "INSERT INTO folders" in db._pool.execute.call_args[0][0]

    @pytest.mark.asyncio
    async def test_ensure_default_folders(self, db):
        db._pool.execute = AsyncMock()
        await db.ensure_default_folders()
        # Should insert 2 default folders (claude, llm)
        assert db._pool.execute.call_count == 2
        for call in db._pool.execute.call_args_list:
            assert "ON CONFLICT (id) DO NOTHING" in call[0][0]

    @pytest.mark.asyncio
    async def test_ensure_indexes(self, db):
        db._pool.execute = AsyncMock()
        await db.ensure_indexes()
        db._pool.execute.assert_called_once()
        sql = db._pool.execute.call_args[0][0]
        assert "CREATE INDEX IF NOT EXISTS" in sql
        assert "idx_events_session_id_id" in sql
        assert "(session_id, id)" in sql

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

        # Verify tsvector query is used
        fetch_call = db._pool.fetch.call_args
        assert "plainto_tsquery" in fetch_call[0][0]


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

        call_args = db._pool.execute.call_args
        sql = call_args[0][0]
        values = call_args[0][1:]

        assert "node_id" in sql
        assert "test-node" in values


# === 읽음 상태 관리 ===


class TestReadPosition:
    @pytest.mark.asyncio
    async def test_update_last_read_event_id(self, db):
        db._pool.execute = AsyncMock(return_value="UPDATE 1")
        result = await db.update_last_read_event_id("s1", 42)
        assert result is True

    @pytest.mark.asyncio
    async def test_update_last_read_event_id_not_found(self, db):
        db._pool.execute = AsyncMock(return_value="UPDATE 0")
        result = await db.update_last_read_event_id("nonexistent", 42)
        assert result is False

    @pytest.mark.asyncio
    async def test_get_read_position(self, db):
        record = _make_record({"last_event_id": 10, "last_read_event_id": 5})
        db._pool.fetchrow = AsyncMock(return_value=record)

        last_event_id, last_read = await db.get_read_position("s1")
        assert last_event_id == 10
        assert last_read == 5


# === shutdown 관련 ===


class TestShutdown:
    @pytest.mark.asyncio
    async def test_mark_running_at_shutdown(self, db):
        db._pool.execute = AsyncMock()
        await db.mark_running_at_shutdown(["s1", "s2"])
        db._pool.execute.assert_called_once()
        assert "was_running_at_shutdown = TRUE" in db._pool.execute.call_args[0][0]

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
        assert "was_running_at_shutdown = FALSE" in db._pool.execute.call_args[0][0]

    @pytest.mark.asyncio
    async def test_get_shutdown_sessions(self, db):
        records = [
            _make_record({"session_id": "s1", "was_running_at_shutdown": True}),
        ]
        db._pool.fetch = AsyncMock(return_value=records)
        sessions = await db.get_shutdown_sessions()
        assert len(sessions) == 1
