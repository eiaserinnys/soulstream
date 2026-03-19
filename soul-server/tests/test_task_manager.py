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

        sessions, total = manager.get_all_sessions()
        assert len(sessions) == 2
        assert total == 2


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

    async def test_register_session_sets_task_claude_session_id(self, manager):
        """register_session() 호출 시 task.claude_session_id가 즉시 설정된다.

        서버가 complete_task() 이전에 재시작되더라도, register_session()이
        task.claude_session_id를 저장하므로 graceful_shutdown 시점에
        pre_shutdown_sessions.json에 유효한 claude_session_id가 기록된다.
        """
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        # 초기에는 claude_session_id 없음
        task = await manager.get_task("sess-1")
        assert task.claude_session_id is None

        manager.register_session("claude-abc", "sess-1")

        # register_session 후 즉시 설정되어 있어야 한다
        assert task.claude_session_id == "claude-abc"

    async def test_register_session_for_nonexistent_task_does_not_fail(self, manager):
        """존재하지 않는 agent_session_id에 register_session 해도 에러가 없다"""
        # 에러 없이 완료되어야 함
        manager.register_session("claude-xyz", "sess-nonexistent")
        # 인덱스는 등록됨
        task = manager.get_task_by_claude_session("claude-xyz")
        assert task is None  # 태스크가 없으므로 None

    async def test_get_running_tasks_has_claude_session_id_after_register(self, manager):
        """register_session 후 get_running_tasks()로 조회한 태스크의 claude_session_id가 None이 아니다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        manager.register_session("claude-abc", "sess-1")

        running = manager.get_running_tasks()
        assert len(running) == 1
        assert running[0].claude_session_id == "claude-abc"

    async def test_interrupted_resume_uses_claude_session_id_from_register(self, manager):
        """INTERRUPTED 세션에 add_intervention 시 resume_session_id가 register_session에서 저장된 값을 사용한다.

        시나리오:
        1. create_task로 태스크 생성
        2. register_session으로 claude_session_id 설정 (complete_task 전에 재시작 상황 시뮬레이션)
        3. 세션을 INTERRUPTED 상태로 전환
        4. add_intervention으로 resume
        5. 새 태스크의 resume_session_id가 register_session에서 설정된 값임을 확인
        """
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        manager.register_session("claude-abc", "sess-1")

        # 재시작 상황: complete_task가 불리지 않고 INTERRUPTED로 마킹
        task = await manager.get_task("sess-1")
        task.status = TaskStatus.INTERRUPTED

        # add_intervention → create_task(resume) 호출
        result = await manager.add_intervention(
            agent_session_id="sess-1",
            text="재개해줘",
            user="user1",
        )
        assert result["auto_resumed"] is True

        # resume된 태스크의 resume_session_id가 register_session에서 설정된 값이어야 함
        resumed_task = await manager.get_task("sess-1")
        assert resumed_task.status == TaskStatus.RUNNING
        assert resumed_task.resume_session_id == "claude-abc"


class TestCleanup:
    async def test_cleanup_fixes_orphaned_running(self, manager):
        """오래된 orphaned running 세션을 interrupted로 보정"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")

        # created_at을 과거로 조작 (running 상태, execution_task 없음 → orphaned)
        task_ref = await manager.get_task("sess-1")
        task_ref.created_at = utc_now() - timedelta(hours=25)

        fixed = await manager.cleanup_orphaned_running(max_age_hours=24)
        assert fixed == 1

        task = await manager.get_task("sess-1")
        assert task is not None
        assert task.status.value == "interrupted"

    async def test_cleanup_preserves_completed_tasks(self, manager):
        """완료된 세션은 삭제하지 않고 유지"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "result")

        # 오래된 세션이라도 삭제하지 않음
        task_ref = await manager.get_task("sess-1")
        task_ref.created_at = utc_now() - timedelta(hours=25)

        fixed = await manager.cleanup_orphaned_running(max_age_hours=24)
        assert fixed == 0

        task = await manager.get_task("sess-1")
        assert task is not None


class TestStats:
    async def test_stats(self, manager):
        """통계 조회"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.complete_task("sess-1", "done")

        stats = manager.get_stats()
        assert stats["total_in_memory"] == 2
        assert stats["total_in_catalog"] == 2
        assert stats["running"] == 1
        assert stats["completed"] == 1
        assert stats["error"] == 0
        assert stats["eviction_candidates"] == 1


