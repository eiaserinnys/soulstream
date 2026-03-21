"""
읽음 상태 관리 테스트 (Phase 1: 서버 측)

T1. DB 마이그레이션: 기존 DB에 last_event_id/last_read_event_id 컬럼 추가
T2. 이벤트 삽입 시 last_event_id 갱신
T3. read-position API 정상
T4. read-position API 잘못된 세션 → 404
T5. GET /sessions 응답에 last_event_id, last_read_event_id 포함
T6. SSE 페이로드 (session_updated): last_event_id, last_read_event_id 포함
T7. SSE 페이로드 (session_message_updated): last_event_id, last_read_event_id 포함
T8. 크로스 대시보드: read-position 갱신 → session_updated SSE 브로드캐스트 발행
T9. 신규 세션: Task.to_session_info()에 last_event_id=0, last_read_event_id=0
T10. session_created 페이로드: last_event_id, last_read_event_id 포함
"""

import asyncio
import json
import sqlite3
from pathlib import Path

import pytest
import pytest_asyncio

from soul_server.service.session_db import SessionDB
from soul_server.service.task_models import Task, TaskStatus
from soul_server.service.session_broadcaster import (
    SessionBroadcaster,
    set_session_broadcaster,
)


@pytest.fixture
def db(tmp_path):
    """tmp_path에 DB 생성"""
    db_path = tmp_path / "test.db"
    sdb = SessionDB(db_path)
    yield sdb
    sdb.close()


@pytest.fixture(autouse=True)
def reset_broadcaster():
    """각 테스트 전후로 broadcaster 상태 초기화"""
    set_session_broadcaster(None)
    yield
    set_session_broadcaster(None)


# ============================================================
# T1. DB 마이그레이션
# ============================================================


class TestDBMigration:
    def test_new_db_has_columns(self, db):
        """T1a: 새 DB 생성 시 last_event_id, last_read_event_id 컬럼 존재"""
        db.upsert_session("s1", session_type="claude", status="running")
        s = db.get_session("s1")
        assert s is not None
        assert "last_event_id" in s
        assert "last_read_event_id" in s
        assert s["last_event_id"] == 0
        assert s["last_read_event_id"] == 0

    def test_migration_adds_columns_to_existing_db(self, tmp_path):
        """T1b: 기존 DB에 컬럼이 없을 때 마이그레이션으로 추가"""
        db_path = tmp_path / "legacy.db"
        # 컬럼 없이 스키마 생성
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                folder_id TEXT,
                display_name TEXT,
                session_type TEXT NOT NULL DEFAULT 'claude',
                status TEXT NOT NULL DEFAULT 'running',
                prompt TEXT,
                client_id TEXT,
                claude_session_id TEXT,
                last_message TEXT,
                metadata TEXT,
                was_running_at_shutdown INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT,
                payload TEXT NOT NULL,
                searchable_text TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        # FTS5 테이블 (SessionDB.__init__이 executescript할 때 필요)
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
                searchable_text,
                content=events,
                content_rowid=id,
                tokenize='unicode61'
            )
        """)
        conn.execute("INSERT INTO sessions (session_id, created_at, updated_at) VALUES ('old1', '2026-01-01', '2026-01-01')")
        conn.commit()
        conn.close()

        # SessionDB 재생성 → 마이그레이션 실행
        sdb = SessionDB(db_path)
        s = sdb.get_session("old1")
        assert s is not None
        assert s["last_event_id"] == 0
        assert s["last_read_event_id"] == 0
        sdb.close()


# ============================================================
# T2. 이벤트 삽입 시 last_event_id 갱신
# ============================================================


class TestLastEventIdUpdate:
    def test_append_event_updates_last_event_id(self, db):
        """T2: insert_event 후 세션의 last_event_id가 새 이벤트 ID와 일치"""
        db.upsert_session("s1", session_type="claude", status="running")
        event_id = db.get_next_event_id("s1")
        db.append_event("s1", event_id, "text_delta", '{"text":"hi"}', "hi", "2026-01-01T00:00:00Z")

        s = db.get_session("s1")
        assert s["last_event_id"] == event_id

    def test_multiple_events_update_last_event_id(self, db):
        """T2b: 여러 이벤트 삽입 시 마지막 이벤트 ID로 갱신"""
        db.upsert_session("s1", session_type="claude", status="running")
        for i in range(1, 4):
            db.append_event("s1", i, "text_delta", f'{{"text":"msg{i}"}}', f"msg{i}", f"2026-01-01T00:00:0{i}Z")

        s = db.get_session("s1")
        assert s["last_event_id"] == 3


# ============================================================
# T3. read-position API 정상
# ============================================================


class TestReadPositionMethods:
    def test_update_last_read_event_id(self, db):
        """T3: update_last_read_event_id 정상 동작"""
        db.upsert_session("s1", session_type="claude", status="running")
        result = db.update_last_read_event_id("s1", 42)
        assert result is True

        s = db.get_session("s1")
        assert s["last_read_event_id"] == 42

    def test_get_read_position(self, db):
        """T3b: get_read_position 반환 확인"""
        db.upsert_session("s1", session_type="claude", status="running")
        db.append_event("s1", 10, "text_delta", '{"text":"hi"}', "hi", "2026-01-01T00:00:00Z")
        db.update_last_read_event_id("s1", 5)

        last_event_id, last_read_event_id = db.get_read_position("s1")
        assert last_event_id == 10
        assert last_read_event_id == 5


# ============================================================
# T4. read-position API 잘못된 세션
# ============================================================


class TestReadPositionErrors:
    def test_update_nonexistent_session_returns_false(self, db):
        """T4a: 존재하지 않는 세션 → False"""
        result = db.update_last_read_event_id("nonexistent", 42)
        assert result is False

    def test_get_read_position_nonexistent_session_raises(self, db):
        """T4b: 존재하지 않는 세션 → ValueError"""
        with pytest.raises(ValueError, match="Session not found"):
            db.get_read_position("nonexistent")


# ============================================================
# T5. GET /sessions 응답에 last_event_id, last_read_event_id 포함
# ============================================================


class TestGetSessionsResponse:
    def test_db_sessions_include_read_fields(self, db):
        """T5a: DB 경유 세션에 last_event_id, last_read_event_id 포함"""
        db.upsert_session("s1", session_type="claude", status="completed")
        db.append_event("s1", 5, "text_delta", '{"text":"hi"}', "hi", "2026-01-01T00:00:00Z")
        db.update_last_read_event_id("s1", 3)

        sessions, total = db.get_all_sessions()
        assert total == 1
        s = sessions[0]
        assert s["last_event_id"] == 5
        assert s["last_read_event_id"] == 3

    def test_task_to_session_info_includes_read_fields(self):
        """T5b: Task.to_session_info()에 last_event_id, last_read_event_id 포함"""
        task = Task(
            agent_session_id="s1",
            prompt="test",
            status=TaskStatus.RUNNING,
        )
        # 기본값 확인
        info = task.to_session_info()
        assert "last_event_id" in info
        assert "last_read_event_id" in info
        assert info["last_event_id"] == 0
        assert info["last_read_event_id"] == 0

    def test_task_with_updated_read_fields(self):
        """T5c: Task의 read 필드가 갱신되면 to_session_info에 반영"""
        task = Task(
            agent_session_id="s1",
            prompt="test",
            status=TaskStatus.RUNNING,
            last_event_id=10,
            last_read_event_id=7,
        )
        info = task.to_session_info()
        assert info["last_event_id"] == 10
        assert info["last_read_event_id"] == 7


# ============================================================
# T6. SSE 페이로드 (session_updated)
# ============================================================


class TestSSESessionUpdated:
    @pytest.mark.asyncio
    async def test_emit_session_updated_includes_read_fields(self):
        """T6: emit_session_updated 페이로드에 last_event_id, last_read_event_id 포함"""
        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        task = Task(
            agent_session_id="s1",
            prompt="test",
            status=TaskStatus.RUNNING,
            last_event_id=15,
            last_read_event_id=10,
        )
        await broadcaster.emit_session_updated(task)

        event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["last_event_id"] == 15
        assert event["last_read_event_id"] == 10


# ============================================================
# T7. SSE 페이로드 (session_message_updated)
# ============================================================


class TestSSESessionMessageUpdated:
    @pytest.mark.asyncio
    async def test_emit_session_message_updated_includes_read_fields(self):
        """T7: emit_session_message_updated 페이로드에 last_event_id, last_read_event_id 포함"""
        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        await broadcaster.emit_session_message_updated(
            agent_session_id="s1",
            status="running",
            updated_at="2026-01-01T00:00:00Z",
            last_message={"type": "text_delta", "preview": "hi", "timestamp": "2026-01-01T00:00:00Z"},
            last_event_id=20,
            last_read_event_id=15,
        )

        event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["last_event_id"] == 20
        assert event["last_read_event_id"] == 15


# ============================================================
# T8. 크로스 대시보드 read-position 갱신 → SSE 브로드캐스트
# ============================================================


class TestCrossDashboardBroadcast:
    @pytest.mark.asyncio
    async def test_emit_read_position_updated(self):
        """T8: read-position 갱신 시 session_updated SSE 브로드캐스트 발행"""
        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        await broadcaster.emit_read_position_updated(
            session_id="s1",
            last_event_id=30,
            last_read_event_id=25,
        )

        event = queue.get_nowait()
        assert event["type"] == "session_updated"
        assert event["agent_session_id"] == "s1"
        assert event["last_event_id"] == 30
        assert event["last_read_event_id"] == 25


# ============================================================
# T9. 신규 세션 기본값
# ============================================================


class TestNewSessionDefaults:
    def test_new_task_defaults(self):
        """T9: 새 Task의 last_event_id, last_read_event_id 기본값은 0"""
        task = Task(agent_session_id="new1", prompt="hello")
        assert task.last_event_id == 0
        assert task.last_read_event_id == 0

        info = task.to_session_info()
        assert info["last_event_id"] == 0
        assert info["last_read_event_id"] == 0


# ============================================================
# T10. session_created 페이로드
# ============================================================


class TestSessionCreatedPayload:
    @pytest.mark.asyncio
    async def test_session_created_includes_read_fields(self):
        """T10: emit_session_created 페이로드에 last_event_id, last_read_event_id 포함"""
        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        task = Task(
            agent_session_id="new1",
            prompt="hello",
            status=TaskStatus.RUNNING,
        )
        await broadcaster.emit_session_created(task)

        event = queue.get_nowait()
        assert event["type"] == "session_created"
        session = event["session"]
        assert "last_event_id" in session
        assert "last_read_event_id" in session
        assert session["last_event_id"] == 0
        assert session["last_read_event_id"] == 0
