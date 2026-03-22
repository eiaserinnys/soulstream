"""claude_session_id 인덱스 및 개입 테스트

TaskManager의 claude_session_id 역방향 인덱스와
agent_session_id 기반 개입(intervention) 기능을 검증합니다.

현재 API 구조:
- register_session(claude_session_id, agent_session_id): SDK 세션 ID 매핑
- get_task_by_claude_session(claude_session_id): SDK 세션 ID로 태스크 조회
- add_intervention(agent_session_id, text, user): agent_session_id로 개입 추가
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.models.schemas import SessionEvent, SSEEventType
from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_models import (
    TaskNotFoundError,
    TaskNotRunningError,
    TaskStatus,
)


def _make_mock_db():
    db = MagicMock()
    db._pool = AsyncMock()
    db.node_id = "test-node"
    db.upsert_session = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.delete_session = AsyncMock()
    db.append_event = AsyncMock(return_value=1)
    db.read_events = AsyncMock(return_value=[])
    db.update_last_read_event_id = AsyncMock(return_value=True)
    db.get_read_position = AsyncMock(return_value=(0, 0))
    db.get_all_folders = AsyncMock(return_value=[
        {"id": "claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0},
        {"id": "llm", "name": "⚙️ LLM 세션", "sort_order": 1},
    ])
    db.get_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0})
    db.create_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.update_last_message = AsyncMock()
    db.search_events = AsyncMock(return_value=[])
    db.get_default_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0})
    db.assign_session_to_folder = AsyncMock()
    db.DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}
    return db


@pytest.fixture
def manager():
    """Mock DB를 가진 TaskManager"""
    m = TaskManager(session_db=_make_mock_db())
    yield m
    set_task_manager(None)


class TestSessionEventModel:
    """SessionEvent Pydantic 모델"""

    def test_session_event_type(self):
        event = SessionEvent(session_id="sess-abc123")
        assert event.type == "session"
        assert event.session_id == "sess-abc123"

    def test_session_event_model_dump(self):
        event = SessionEvent(session_id="sess-abc123")
        d = event.model_dump()
        assert d == {"type": "session", "session_id": "sess-abc123", "pid": None}

    def test_session_event_with_pid(self):
        event = SessionEvent(session_id="sess-abc123", pid=12345)
        d = event.model_dump()
        assert d == {"type": "session", "session_id": "sess-abc123", "pid": 12345}

    def test_sse_event_type_session(self):
        assert SSEEventType.SESSION == "session"
        assert SSEEventType.SESSION.value == "session"


class TestClaudeSessionIndex:
    """TaskManager claude_session_id 역방향 인덱스"""

    async def test_register_and_lookup(self, manager):
        """claude_session_id 등록 후 조회"""
        task = await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")
        manager.register_session("claude-sess-abc", "agent-sess-1")

        found = manager.get_task_by_claude_session("claude-sess-abc")
        assert found is not None
        assert found.agent_session_id == "agent-sess-1"
        assert found.prompt == "hello"

    async def test_lookup_nonexistent(self, manager):
        """등록되지 않은 claude_session_id 조회"""
        task = manager.get_task_by_claude_session("nonexistent")
        assert task is None

    async def test_multiple_sessions(self, manager):
        """여러 태스크에 각각 다른 claude_session_id"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")
        await manager.create_task(prompt="world", agent_session_id="agent-sess-2")

        manager.register_session("claude-1", "agent-sess-1")
        manager.register_session("claude-2", "agent-sess-2")

        t1 = manager.get_task_by_claude_session("claude-1")
        t2 = manager.get_task_by_claude_session("claude-2")

        assert t1 is not None
        assert t2 is not None
        assert t1.agent_session_id == "agent-sess-1"
        assert t2.agent_session_id == "agent-sess-2"

    async def test_session_overwrite(self, manager):
        """동일한 claude_session_id로 다른 agent_session_id 매핑 시 덮어쓰기"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")
        await manager.create_task(prompt="world", agent_session_id="agent-sess-2")

        manager.register_session("claude-shared", "agent-sess-1")
        manager.register_session("claude-shared", "agent-sess-2")  # 덮어쓰기

        found = manager.get_task_by_claude_session("claude-shared")
        assert found is not None
        assert found.agent_session_id == "agent-sess-2"


class TestInterventionByAgentSession:
    """agent_session_id 기반 개입 메시지"""

    async def test_add_intervention_running(self, manager):
        """running 상태 태스크에 개입 메시지 추가"""
        task = await manager.create_task(
            prompt="hello", agent_session_id="agent-sess-1"
        )

        result = await manager.add_intervention(
            "agent-sess-1", text="새 질문", user="user1"
        )
        assert "queue_position" in result
        assert result["queue_position"] == 1

        # 메시지 확인
        msg = await manager.get_intervention("agent-sess-1")
        assert msg is not None
        assert msg["text"] == "새 질문"
        assert msg["user"] == "user1"

    async def test_add_intervention_not_found(self, manager):
        """존재하지 않는 agent_session_id로 개입"""
        with pytest.raises(TaskNotFoundError):
            await manager.add_intervention("nonexistent", "text", "user1")

    async def test_add_intervention_auto_resume(self, manager):
        """완료된 태스크에 개입 시 자동 resume"""
        task = await manager.create_task(
            prompt="hello", agent_session_id="agent-sess-1"
        )
        await manager.complete_task("agent-sess-1", "done")

        # 완료된 태스크에 개입 → 자동 resume
        result = await manager.add_intervention(
            "agent-sess-1", text="새 질문", user="user1"
        )
        assert result.get("auto_resumed") is True
        assert result.get("agent_session_id") == "agent-sess-1"

        # 태스크가 다시 running 상태
        task = await manager.get_task("agent-sess-1")
        assert task is not None
        assert task.status == TaskStatus.RUNNING
        assert task.prompt == "새 질문"

    async def test_multiple_interventions(self, manager):
        """여러 개입 메시지 추가"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")

        result1 = await manager.add_intervention("agent-sess-1", "msg1", "user1")
        result2 = await manager.add_intervention("agent-sess-1", "msg2", "user1")

        assert result1["queue_position"] == 1
        assert result2["queue_position"] == 2

        msg1 = await manager.get_intervention("agent-sess-1")
        msg2 = await manager.get_intervention("agent-sess-1")
        assert msg1["text"] == "msg1"
        assert msg2["text"] == "msg2"

    async def test_intervention_with_attachments(self, manager):
        """첨부 파일 포함 개입"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")

        result = await manager.add_intervention(
            "agent-sess-1",
            text="파일 봐주세요",
            user="user1",
            attachment_paths=["/tmp/file1.png", "/tmp/file2.txt"],
        )
        assert result["queue_position"] == 1

        msg = await manager.get_intervention("agent-sess-1")
        assert msg["text"] == "파일 봐주세요"
        assert msg["attachment_paths"] == ["/tmp/file1.png", "/tmp/file2.txt"]

    async def test_get_intervention_empty(self, manager):
        """개입 메시지가 없을 때"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")

        msg = await manager.get_intervention("agent-sess-1")
        assert msg is None

    async def test_get_intervention_not_found(self, manager):
        """존재하지 않는 agent_session_id로 개입 조회"""
        msg = await manager.get_intervention("nonexistent")
        assert msg is None


class TestTaskCompletion:
    """태스크 완료/에러 처리"""

    async def test_complete_task_saves_claude_session_id(self, manager):
        """완료 시 claude_session_id 저장 (resume용)"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")

        await manager.complete_task(
            "agent-sess-1", result="done", claude_session_id="claude-sess-xyz"
        )

        task = await manager.get_task("agent-sess-1")
        assert task is not None
        assert task.status == TaskStatus.COMPLETED
        assert task.result == "done"
        assert task.claude_session_id == "claude-sess-xyz"

    async def test_error_task(self, manager):
        """에러 처리"""
        await manager.create_task(prompt="hello", agent_session_id="agent-sess-1")

        await manager.error_task("agent-sess-1", error="Something went wrong")

        task = await manager.get_task("agent-sess-1")
        assert task is not None
        assert task.status == TaskStatus.ERROR
        assert task.error == "Something went wrong"

    async def test_complete_nonexistent(self, manager):
        """존재하지 않는 태스크 완료 시도"""
        result = await manager.complete_task("nonexistent", "done")
        assert result is None

    async def test_error_nonexistent(self, manager):
        """존재하지 않는 태스크 에러 시도"""
        result = await manager.error_task("nonexistent", "error")
        assert result is None


class TestResumeSession:
    """세션 resume 테스트"""

    async def test_resume_completed_session(self, manager):
        """완료된 세션 resume"""
        task = await manager.create_task(
            prompt="first", agent_session_id="agent-sess-1"
        )
        await manager.complete_task(
            "agent-sess-1", result="done", claude_session_id="claude-sess-xyz"
        )

        # 같은 agent_session_id로 resume
        task = await manager.create_task(
            prompt="second", agent_session_id="agent-sess-1"
        )

        assert task.status == TaskStatus.RUNNING
        assert task.prompt == "second"
        assert task.resume_session_id == "claude-sess-xyz"

    async def test_resume_errored_session(self, manager):
        """에러난 세션 resume"""
        await manager.create_task(prompt="first", agent_session_id="agent-sess-1")
        await manager.error_task("agent-sess-1", error="crashed")

        # resume
        task = await manager.create_task(
            prompt="retry", agent_session_id="agent-sess-1"
        )

        assert task.status == TaskStatus.RUNNING
        assert task.prompt == "retry"
