"""
test_task_manager - CRUD, 충돌 감지, ack, cleanup, agent_session_id 인덱스 테스트
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
    TaskNotRunningError,
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
        task = await manager.create_task("bot", "req1", "sess-1", "hello")
        assert task.client_id == "bot"
        assert task.request_id == "req1"
        assert task.agent_session_id == "sess-1"
        assert task.prompt == "hello"
        assert task.status == TaskStatus.RUNNING

    async def test_create_with_resume(self, manager):
        task = await manager.create_task("bot", "req1", "sess-1", "hello", resume_session_id="claude-sess-1")
        assert task.resume_session_id == "claude-sess-1"

    async def test_create_conflict_running(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        with pytest.raises(TaskConflictError):
            await manager.create_task("bot", "req1", "sess-1", "hello again")

    async def test_create_overwrites_completed(self, manager):
        task1 = await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.complete_task("bot", "req1", "done")

        task2 = await manager.create_task("bot", "req1", "sess-1", "new prompt")
        assert task2.prompt == "new prompt"
        assert task2.status == TaskStatus.RUNNING

    async def test_create_registers_agent_session_index(self, manager):
        """create_task가 agent_session_id 인덱스를 등록한다"""
        await manager.create_task("bot", "req1", "sess-aaa", "hello")
        task = manager.get_task_by_agent_session("sess-aaa")
        assert task is not None
        assert task.request_id == "req1"


class TestGetTask:
    async def test_get_existing(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        task = await manager.get_task("bot", "req1")
        assert task is not None
        assert task.prompt == "hello"

    async def test_get_nonexistent(self, manager):
        task = await manager.get_task("bot", "nonexistent")
        assert task is None

    async def test_get_tasks_by_client(self, manager):
        await manager.create_task("bot1", "req1", "sess-1", "hello")
        await manager.create_task("bot1", "req2", "sess-2", "world")
        await manager.create_task("bot2", "req1", "sess-3", "other")

        bot1_tasks = await manager.get_tasks_by_client("bot1")
        assert len(bot1_tasks) == 2

        bot2_tasks = await manager.get_tasks_by_client("bot2")
        assert len(bot2_tasks) == 1

    async def test_get_running_tasks(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.create_task("bot", "req2", "sess-2", "world")
        await manager.complete_task("bot", "req1", "done")

        running = manager.get_running_tasks()
        assert len(running) == 1
        assert running[0].request_id == "req2"


class TestCompleteTask:
    async def test_complete_basic(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        task = await manager.complete_task("bot", "req1", "result")

        assert task is not None
        assert task.status == TaskStatus.COMPLETED
        assert task.result == "result"
        assert task.completed_at is not None

    async def test_complete_with_session_id(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        task = await manager.complete_task("bot", "req1", "result", claude_session_id="claude-sess-1")
        assert task.claude_session_id == "claude-sess-1"

    async def test_complete_nonexistent(self, manager):
        task = await manager.complete_task("bot", "nonexistent", "result")
        assert task is None


class TestErrorTask:
    async def test_error_basic(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        task = await manager.error_task("bot", "req1", "something broke")

        assert task is not None
        assert task.status == TaskStatus.ERROR
        assert task.error == "something broke"
        assert task.completed_at is not None

    async def test_error_nonexistent(self, manager):
        task = await manager.error_task("bot", "nonexistent", "error")
        assert task is None


class TestAckTask:
    async def test_ack_removes_task(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.complete_task("bot", "req1", "result")

        success = await manager.ack_task("bot", "req1")
        assert success is True

        task = await manager.get_task("bot", "req1")
        assert task is None

    async def test_ack_nonexistent(self, manager):
        success = await manager.ack_task("bot", "nonexistent")
        assert success is False


class TestMarkDelivered:
    async def test_mark_delivered(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.complete_task("bot", "req1", "result")

        success = await manager.mark_delivered("bot", "req1")
        assert success is True

        task = await manager.get_task("bot", "req1")
        assert task.result_delivered is True

    async def test_mark_delivered_nonexistent(self, manager):
        success = await manager.mark_delivered("bot", "nonexistent")
        assert success is False


class TestIntervention:
    async def test_add_intervention(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        pos = await manager.add_intervention("bot", "req1", "stop", "user1")
        assert pos == 1

    async def test_add_intervention_not_found(self, manager):
        with pytest.raises(TaskNotFoundError):
            await manager.add_intervention("bot", "nonexistent", "stop", "user1")

    async def test_add_intervention_not_running(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.complete_task("bot", "req1", "done")

        with pytest.raises(TaskNotRunningError):
            await manager.add_intervention("bot", "req1", "stop", "user1")

    async def test_get_intervention(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.add_intervention("bot", "req1", "stop", "user1")

        msg = await manager.get_intervention("bot", "req1")
        assert msg is not None
        assert msg["text"] == "stop"
        assert msg["user"] == "user1"

    async def test_get_intervention_empty(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        msg = await manager.get_intervention("bot", "req1")
        assert msg is None


class TestAgentSessionIntervention:
    """agent_session_id 기반 개입 메시지 + 자동 resume"""

    async def test_intervention_running_task(self, manager):
        """running 태스크에 agent_session_id로 개입"""
        await manager.create_task("bot", "req1", "sess-aaa", "hello")

        result = await manager.add_intervention_by_agent_session("sess-aaa", "새 질문", "user1")
        assert "queue_position" in result
        assert result["queue_position"] >= 1

        # 메시지 확인
        msg = await manager.get_intervention("bot", "req1")
        assert msg is not None
        assert msg["text"] == "새 질문"

    async def test_intervention_completed_auto_resume(self, manager):
        """완료된 태스크에 agent_session_id로 개입 → 자동 resume"""
        await manager.create_task("bot", "req1", "sess-aaa", "hello")
        await manager.complete_task("bot", "req1", "done", claude_session_id="claude-sess-1")

        result = await manager.add_intervention_by_agent_session("sess-aaa", "이어서 해줘", "user1")
        assert result["auto_resumed"] is True
        assert "task_key" in result

        # 새 태스크가 동일한 agent_session_id를 사용
        new_task = manager.get_task_by_agent_session("sess-aaa")
        assert new_task is not None
        assert new_task.agent_session_id == "sess-aaa"
        assert new_task.prompt == "이어서 해줘"
        assert new_task.resume_session_id == "claude-sess-1"

    async def test_intervention_not_found(self, manager):
        """존재하지 않는 agent_session_id로 개입"""
        with pytest.raises(TaskNotFoundError):
            await manager.add_intervention_by_agent_session("nonexistent", "text", "user1")

    async def test_get_task_by_agent_session(self, manager):
        """agent_session_id로 태스크 조회"""
        await manager.create_task("bot", "req1", "sess-aaa", "hello")
        task = manager.get_task_by_agent_session("sess-aaa")
        assert task is not None
        assert task.client_id == "bot"
        assert task.request_id == "req1"

    async def test_agent_session_index_survives_completion(self, manager):
        """태스크 완료 후에도 agent_session_index는 유지된다 (자동 resume 지원)"""
        await manager.create_task("bot", "req1", "sess-aaa", "hello")
        await manager.complete_task("bot", "req1", "done")

        # agent_session_index는 여전히 조회 가능 (자동 resume에 필요)
        task = manager.get_task_by_agent_session("sess-aaa")
        assert task is not None


class TestCleanup:
    async def test_cleanup_old_completed_tasks(self, manager):
        task = await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.complete_task("bot", "req1", "result")

        # created_at을 과거로 조작
        task_ref = await manager.get_task("bot", "req1")
        task_ref.created_at = utc_now() - timedelta(hours=25)

        cleaned = await manager.cleanup_old_tasks(max_age_hours=24)
        assert cleaned == 1

        task = await manager.get_task("bot", "req1")
        assert task is None

    async def test_cleanup_preserves_recent_tasks(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.complete_task("bot", "req1", "result")

        cleaned = await manager.cleanup_old_tasks(max_age_hours=24)
        assert cleaned == 0

        task = await manager.get_task("bot", "req1")
        assert task is not None


class TestStats:
    async def test_stats(self, manager):
        await manager.create_task("bot", "req1", "sess-1", "hello")
        await manager.create_task("bot", "req2", "sess-2", "world")
        await manager.complete_task("bot", "req1", "done")

        stats = manager.get_stats()
        assert stats["total"] == 2
        assert stats["running"] == 1
        assert stats["completed"] == 1
        assert stats["error"] == 0
