"""세션 메타데이터 단위 테스트

Phase 1: 메타데이터 저장 + API + MCP
- Task.metadata 필드
- SessionDB.append_metadata()
- synthetic metadata 이벤트 (FTS5 인덱싱)
- TaskManager.append_session_metadata()
- resume 시 기존 metadata 로드
- SSE 이벤트 브로드캐스트
- MCP list_sessions에 metadata 포함
- search_session_history로 metadata 검색 가능
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from soul_server.service.task_models import Task, TaskStatus, utc_now, datetime_to_str
from soul_server.service.session_db import SessionDB


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "test.db"
    sdb = SessionDB(db_path)
    yield sdb
    sdb.close()


# ============================================================
# Task 모델
# ============================================================


class TestTaskMetadataField:
    def test_task_has_metadata_field(self):
        """Task에 metadata 필드가 존재하고 빈 리스트로 초기화"""
        task = Task(agent_session_id="s1", prompt="test")
        assert hasattr(task, "metadata")
        assert task.metadata == []

    def test_task_to_dict_includes_metadata(self):
        """to_dict()에 metadata 포함"""
        task = Task(agent_session_id="s1", prompt="test")
        task.metadata = [{"type": "git_commit", "value": "abc1234"}]
        d = task.to_dict()
        assert "metadata" in d
        assert d["metadata"] == [{"type": "git_commit", "value": "abc1234"}]

    def test_task_from_dict_restores_metadata(self):
        """from_dict()로 metadata 복원"""
        data = {
            "agent_session_id": "s1",
            "prompt": "test",
            "status": "running",
            "created_at": utc_now().isoformat(),
            "metadata": [{"type": "git_commit", "value": "abc1234"}],
        }
        task = Task.from_dict(data)
        assert task.metadata == [{"type": "git_commit", "value": "abc1234"}]

    def test_task_from_dict_without_metadata(self):
        """metadata 키가 없는 dict에서 빈 리스트로 복원"""
        data = {
            "agent_session_id": "s1",
            "prompt": "test",
            "status": "running",
            "created_at": utc_now().isoformat(),
        }
        task = Task.from_dict(data)
        assert task.metadata == []

    def test_task_to_session_info_includes_metadata(self):
        """to_session_info()에 metadata 포함"""
        task = Task(agent_session_id="s1", prompt="test")
        task.metadata = [{"type": "git_commit", "value": "abc1234"}]
        info = task.to_session_info()
        assert "metadata" in info
        assert info["metadata"] == [{"type": "git_commit", "value": "abc1234"}]

    def test_task_to_session_info_empty_metadata(self):
        """to_session_info()에 빈 metadata도 항상 포함 (키 존재)"""
        task = Task(agent_session_id="s1", prompt="test")
        info = task.to_session_info()
        assert "metadata" in info
        assert info["metadata"] == []


# ============================================================
# SessionDB.append_metadata()
# ============================================================


class TestSessionDBAppendMetadata:
    def test_append_metadata_to_empty(self, db):
        """빈 metadata에 엔트리 추가"""
        db.upsert_session("s1", status="running", session_type="claude")
        entry = {"type": "git_commit", "value": "abc1234", "tool_name": "Bash"}
        db.append_metadata("s1", entry)

        session = db.get_session("s1")
        assert session["metadata"] == [entry]

    def test_append_metadata_multiple(self, db):
        """여러 엔트리 순차 추가"""
        db.upsert_session("s1", status="running", session_type="claude")
        e1 = {"type": "git_commit", "value": "abc1234", "tool_name": "Bash"}
        e2 = {"type": "trello_card", "value": "card-id", "tool_name": "mcp__trello"}
        db.append_metadata("s1", e1)
        db.append_metadata("s1", e2)

        session = db.get_session("s1")
        assert len(session["metadata"]) == 2
        assert session["metadata"][0] == e1
        assert session["metadata"][1] == e2

    def test_append_metadata_inserts_synthetic_event(self, db):
        """metadata 추가 시 synthetic 이벤트가 events 테이블에 삽입"""
        db.upsert_session("s1", status="running", session_type="claude")
        entry = {"type": "git_commit", "value": "abc1234", "label": "fix bug"}
        db.append_metadata("s1", entry)

        events = db.read_events("s1")
        assert len(events) == 1
        assert events[0]["event_type"] == "metadata"
        assert "git_commit" in events[0]["searchable_text"]
        assert "abc1234" in events[0]["searchable_text"]
        assert "fix bug" in events[0]["searchable_text"]

    def test_append_metadata_synthetic_event_fts_searchable(self, db):
        """synthetic 이벤트가 FTS5로 검색 가능"""
        db.upsert_session("s1", status="running", session_type="claude")
        entry = {"type": "trello_card", "value": "card-123", "label": "Phase 1 카드"}
        db.append_metadata("s1", entry)

        results = db.search_events("trello_card")
        assert len(results) >= 1
        assert results[0]["session_id"] == "s1"

    def test_append_metadata_nonexistent_session(self, db):
        """존재하지 않는 세션에 추가하면 에러"""
        entry = {"type": "git_commit", "value": "abc1234"}
        with pytest.raises(ValueError, match="not found"):
            db.append_metadata("nonexistent", entry)


# ============================================================
# TaskManager.append_session_metadata() + SSE
# ============================================================


class TestTaskManagerAppendMetadata:
    @pytest.fixture
    def task_manager(self, db):
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.session_broadcaster import (
            SessionBroadcaster,
            set_session_broadcaster,
        )

        broadcaster = SessionBroadcaster()
        set_session_broadcaster(broadcaster)
        tm = TaskManager(session_db=db)
        yield tm
        set_session_broadcaster(None)

    @pytest.mark.asyncio
    async def test_append_session_metadata_stores_in_task_and_db(self, task_manager, db):
        """Task.metadata와 DB에 모두 기록"""
        task = await task_manager.create_task(prompt="test")
        sid = task.agent_session_id

        entry = {
            "type": "git_commit",
            "value": "abc1234",
            "label": "fix bug",
            "timestamp": utc_now().isoformat(),
            "tool_name": "Bash",
        }
        await task_manager.append_session_metadata(sid, entry)

        # Task 메모리 확인
        assert len(task.metadata) == 1
        assert task.metadata[0] == entry

        # DB 확인
        session = db.get_session(sid)
        assert len(session["metadata"]) == 1

    @pytest.mark.asyncio
    async def test_append_session_metadata_broadcasts_sse(self, task_manager, db):
        """metadata_updated SSE 이벤트 브로드캐스트"""
        from soul_server.service.session_broadcaster import get_session_broadcaster

        task = await task_manager.create_task(prompt="test")
        sid = task.agent_session_id

        # SSE 리스너 등록
        broadcaster = get_session_broadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        # 기존 이벤트 소비 (session_created 등)
        while not queue.empty():
            queue.get_nowait()

        entry = {
            "type": "git_commit",
            "value": "abc1234",
            "timestamp": utc_now().isoformat(),
            "tool_name": "Bash",
        }
        await task_manager.append_session_metadata(sid, entry)

        # metadata_updated 이벤트 확인
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())

        metadata_events = [e for e in events if e.get("type") == "metadata_updated"]
        assert len(metadata_events) == 1
        assert metadata_events[0]["session_id"] == sid
        assert metadata_events[0]["entry"] == entry
        assert len(metadata_events[0]["metadata"]) == 1

        # session_updated 이벤트도 발행되는지 확인
        session_events = [e for e in events if e.get("type") == "session_updated"]
        assert len(session_events) >= 1

        await broadcaster.remove_listener(queue)


# ============================================================
# Resume 시 metadata 연속성
# ============================================================


class TestResumeMetadataContinuity:
    @pytest.fixture
    def task_manager(self, db):
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.session_broadcaster import (
            SessionBroadcaster,
            set_session_broadcaster,
        )

        broadcaster = SessionBroadcaster()
        set_session_broadcaster(broadcaster)
        tm = TaskManager(session_db=db)
        yield tm
        set_session_broadcaster(None)

    @pytest.mark.asyncio
    async def test_resume_loads_existing_metadata(self, task_manager, db):
        """resume 시 기존 metadata가 Task에 로드"""
        # 새 세션 생성 + metadata 추가
        task = await task_manager.create_task(prompt="first")
        sid = task.agent_session_id
        entry = {"type": "git_commit", "value": "abc1234", "tool_name": "Bash",
                 "timestamp": utc_now().isoformat()}
        await task_manager.append_session_metadata(sid, entry)

        # 완료
        await task_manager.complete_task(sid, "done", "claude-session-1")

        # resume
        resumed = await task_manager.create_task(prompt="second", agent_session_id=sid)

        # metadata가 유지되어야 함
        assert len(resumed.metadata) == 1
        assert resumed.metadata[0]["value"] == "abc1234"


# ============================================================
# MCP list_sessions에 metadata 포함
# ============================================================


class TestMCPMetadata:
    def test_get_all_sessions_includes_metadata(self, db):
        """get_all_sessions 반환에 metadata 포함"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.session_broadcaster import (
            SessionBroadcaster,
            set_session_broadcaster,
        )

        broadcaster = SessionBroadcaster()
        set_session_broadcaster(broadcaster)
        tm = TaskManager(session_db=db)

        # DB에 직접 metadata가 있는 세션 생성
        db.upsert_session(
            "s1",
            status="running",
            session_type="claude",
            prompt="test",
            metadata=json.dumps([{"type": "git_commit", "value": "abc"}]),
            created_at=utc_now().isoformat(),
        )

        sessions, total = tm.get_all_sessions()
        assert total == 1
        assert "metadata" in sessions[0]
        assert sessions[0]["metadata"] == [{"type": "git_commit", "value": "abc"}]

        set_session_broadcaster(None)
