"""
test_task_manager - 세션 CRUD, 충돌 감지, cleanup, agent_session_id 기반 테스트

현재 API는 agent_session_id를 단일 primary key로 사용합니다.
"""

import asyncio
from datetime import timedelta

import pytest

from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_models import (
    Task,
    TaskStatus,
    TaskConflictError,
    TaskNotFoundError,
    utc_now,
)


@pytest.fixture
def manager():
    """영속화 없는 TaskManager"""
    m = TaskManager(storage_path=None)
    yield m
    set_task_manager(None)


class TestCreateTask:
    async def test_create_basic(self, manager):
        """기본 세션 생성"""
        task = await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
            client_id="bot",
        )
        assert task.prompt == "hello"
        assert task.agent_session_id == "sess-1"
        assert task.client_id == "bot"
        assert task.status == TaskStatus.RUNNING

    async def test_create_auto_generates_session_id(self, manager):
        """agent_session_id 미제공 시 자동 생성"""
        task = await manager.create_task(prompt="hello")
        assert task.agent_session_id is not None
        assert task.agent_session_id.startswith("sess-")

    async def test_create_conflict_running(self, manager):
        """이미 running인 세션에 재생성 시도 → 충돌"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        with pytest.raises(TaskConflictError):
            await manager.create_task(prompt="hello again", agent_session_id="sess-1")

    async def test_create_overwrites_completed(self, manager):
        """완료된 세션 resume"""
        task1 = await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
        )
        await manager.complete_task("sess-1", "done")

        task2 = await manager.create_task(
            prompt="new prompt",
            agent_session_id="sess-1",
        )
        assert task2.prompt == "new prompt"
        assert task2.status == TaskStatus.RUNNING
        # 같은 agent_session_id가 재활성화됨
        assert task2.agent_session_id == "sess-1"


class TestGetTask:
    async def test_get_existing(self, manager):
        """존재하는 세션 조회"""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
        )
        task = await manager.get_task("sess-1")
        assert task is not None
        assert task.prompt == "hello"

    async def test_get_nonexistent(self, manager):
        """존재하지 않는 세션 조회"""
        task = await manager.get_task("nonexistent")
        assert task is None

    async def test_get_running_tasks(self, manager):
        """running 상태 세션 목록 조회"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.complete_task("sess-1", "done")

        running = manager.get_running_tasks()
        assert len(running) == 1
        assert running[0].agent_session_id == "sess-2"

    async def test_get_all_sessions(self, manager):
        """전체 세션 목록 조회"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.complete_task("sess-1", "done")

        sessions = manager.get_all_sessions()
        assert len(sessions) == 2


class TestCompleteTask:
    async def test_complete_basic(self, manager):
        """기본 세션 완료"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.complete_task("sess-1", "result")

        assert task is not None
        assert task.status == TaskStatus.COMPLETED
        assert task.result == "result"
        assert task.completed_at is not None

    async def test_complete_with_session_id(self, manager):
        """claude_session_id 포함 완료"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.complete_task(
            "sess-1", "result", claude_session_id="claude-sess-1"
        )
        assert task.claude_session_id == "claude-sess-1"

    async def test_complete_nonexistent(self, manager):
        """존재하지 않는 세션 완료 시도"""
        task = await manager.complete_task("nonexistent", "result")
        assert task is None


class TestErrorTask:
    async def test_error_basic(self, manager):
        """기본 세션 에러 처리"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.error_task("sess-1", "something broke")

        assert task is not None
        assert task.status == TaskStatus.ERROR
        assert task.error == "something broke"
        assert task.completed_at is not None

    async def test_error_nonexistent(self, manager):
        """존재하지 않는 세션 에러 시도"""
        task = await manager.error_task("nonexistent", "error")
        assert task is None


class TestIntervention:
    async def test_add_intervention_running(self, manager):
        """running 세션에 개입 메시지 추가"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        result = await manager.add_intervention(
            agent_session_id="sess-1",
            text="stop",
            user="user1",
        )
        assert "queue_position" in result
        assert result["queue_position"] >= 1

    async def test_add_intervention_auto_resume(self, manager):
        """완료된 세션에 개입 → 자동 resume"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done", claude_session_id="claude-sess-1")

        result = await manager.add_intervention(
            agent_session_id="sess-1",
            text="이어서 해줘",
            user="user1",
        )
        assert result["auto_resumed"] is True

        # 세션이 재활성화됨
        task = await manager.get_task("sess-1")
        assert task.status == TaskStatus.RUNNING
        assert task.prompt == "이어서 해줘"

    async def test_add_intervention_not_found(self, manager):
        """존재하지 않는 세션에 개입 시도"""
        with pytest.raises(TaskNotFoundError):
            await manager.add_intervention(
                agent_session_id="nonexistent",
                text="stop",
                user="user1",
            )

    async def test_get_intervention(self, manager):
        """개입 메시지 가져오기"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.add_intervention(
            agent_session_id="sess-1",
            text="stop",
            user="user1",
        )

        msg = await manager.get_intervention("sess-1")
        assert msg is not None
        assert msg["text"] == "stop"
        assert msg["user"] == "user1"

    async def test_get_intervention_empty(self, manager):
        """개입 메시지가 없을 때"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        msg = await manager.get_intervention("sess-1")
        assert msg is None


class TestClaudeSessionIndex:
    async def test_register_and_get_by_claude_session(self, manager):
        """claude_session_id 인덱스 등록 및 조회"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        manager.register_session("claude-sess-abc", "sess-1")

        task = manager.get_task_by_claude_session("claude-sess-abc")
        assert task is not None
        assert task.agent_session_id == "sess-1"

    async def test_get_by_claude_session_not_found(self, manager):
        """등록되지 않은 claude_session_id 조회"""
        task = manager.get_task_by_claude_session("nonexistent")
        assert task is None


class TestCleanup:
    async def test_cleanup_old_completed_tasks(self, manager):
        """오래된 완료 세션 정리"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "result")

        # created_at을 과거로 조작
        task_ref = await manager.get_task("sess-1")
        task_ref.created_at = utc_now() - timedelta(hours=25)

        cleaned = await manager.cleanup_old_tasks(max_age_hours=24)
        assert cleaned == 1

        task = await manager.get_task("sess-1")
        assert task is None

    async def test_cleanup_preserves_recent_tasks(self, manager):
        """최근 세션은 정리 안 함"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "result")

        cleaned = await manager.cleanup_old_tasks(max_age_hours=24)
        assert cleaned == 0

        task = await manager.get_task("sess-1")
        assert task is not None


class TestStats:
    async def test_stats(self, manager):
        """통계 조회"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.complete_task("sess-1", "done")

        stats = manager.get_stats()
        assert stats["total"] == 2
        assert stats["running"] == 1
        assert stats["completed"] == 1
        assert stats["error"] == 0
