"""
test_eviction - TaskManager 세션 퇴거 + 카탈로그 통합 테스트
"""

import asyncio
import time

import pytest

from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_models import TaskStatus, utc_now


@pytest.fixture
def manager():
    """영속화 없는 TaskManager (짧은 TTL)"""
    m = TaskManager(storage_path=None, eviction_ttl=1)  # 1초 TTL
    yield m
    # 퇴거 루프가 있으면 취소
    if m._eviction_task and not m._eviction_task.done():
        m._eviction_task.cancel()
    set_task_manager(None)


class TestCatalogIntegration:
    async def test_create_task_registers_in_catalog(self, manager: TaskManager):
        """create_task()가 카탈로그에 엔트리를 등록"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1", client_id="bot")

        entry = manager._catalog.get("sess-1")
        assert entry is not None
        assert entry["status"] == "running"
        assert entry["prompt"] == "hello"
        assert entry["client_id"] == "bot"

    async def test_complete_task_updates_catalog(self, manager: TaskManager):
        """complete_task()가 카탈로그 상태를 업데이트"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "result", claude_session_id="claude-1")

        entry = manager._catalog.get("sess-1")
        assert entry["status"] == "completed"
        assert entry["claude_session_id"] == "claude-1"
        assert entry["completed_at"] is not None

    async def test_error_task_updates_catalog(self, manager: TaskManager):
        """error_task()가 카탈로그 상태를 업데이트"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.error_task("sess-1", "boom")

        entry = manager._catalog.get("sess-1")
        assert entry["status"] == "error"
        assert entry["completed_at"] is not None

    async def test_get_all_sessions_from_catalog(self, manager: TaskManager):
        """get_all_sessions()가 카탈로그 기반 dict를 반환"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.complete_task("sess-1", "done")

        sessions, total = manager.get_all_sessions()
        assert total == 2
        assert len(sessions) == 2
        # dict로 반환
        assert isinstance(sessions[0], dict)
        assert "agent_session_id" in sessions[0]
        assert "status" in sessions[0]
        assert "last_message" in sessions[0]
        assert "updated_at" in sessions[0]


class TestEviction:
    async def test_completed_session_becomes_eviction_candidate(self, manager: TaskManager):
        """완료된 세션이 퇴거 후보에 등록"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done")

        assert "sess-1" in manager._eviction_candidates

    async def test_eviction_check_removes_expired(self, manager: TaskManager):
        """TTL 만료된 세션이 _tasks에서 제거"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done")

        # TTL을 과거로 조작
        manager._eviction_candidates["sess-1"] = time.time() - 1

        evicted = manager._run_eviction_check()
        assert evicted == 1
        assert "sess-1" not in manager._tasks
        assert "sess-1" not in manager._eviction_candidates

    async def test_eviction_preserves_running_sessions(self, manager: TaskManager):
        """running 세션은 퇴거 후보에 등록되지 않음"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        assert "sess-1" not in manager._eviction_candidates

    async def test_evicted_session_still_in_catalog(self, manager: TaskManager):
        """퇴거된 세션은 카탈로그에 여전히 존재"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()

        # _tasks에는 없지만 카탈로그에는 있음
        assert "sess-1" not in manager._tasks
        entry = manager._catalog.get("sess-1")
        assert entry is not None
        assert entry["status"] == "completed"

    async def test_evicted_session_loadable_via_get_task(self, manager: TaskManager):
        """퇴거된 세션을 get_task()로 조회 가능 (on-demand 로드)"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1", client_id="bot")
        await manager.complete_task("sess-1", "done", claude_session_id="claude-1")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()

        # on-demand 로드
        task = await manager.get_task("sess-1")
        assert task is not None
        assert task.agent_session_id == "sess-1"
        assert task.status == TaskStatus.COMPLETED
        assert task.claude_session_id == "claude-1"

        # 메모리에 상주시키지 않음
        assert "sess-1" not in manager._tasks

    async def test_lru_refresh_on_access(self, manager: TaskManager):
        """LRU 캐시 히트 시 TTL 갱신"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done")

        original_expiry = manager._eviction_candidates["sess-1"]

        # get_task로 접근 → TTL 갱신
        await asyncio.sleep(0.1)
        await manager.get_task("sess-1")

        new_expiry = manager._eviction_candidates["sess-1"]
        assert new_expiry > original_expiry

    async def test_resume_removes_from_eviction_candidates(self, manager: TaskManager):
        """resume 시 퇴거 후보에서 제거"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done")
        assert "sess-1" in manager._eviction_candidates

        # resume
        await manager.create_task(prompt="continue", agent_session_id="sess-1")
        assert "sess-1" not in manager._eviction_candidates

    async def test_resume_evicted_session(self, manager: TaskManager):
        """퇴거된 세션의 resume"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done", claude_session_id="claude-1")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()
        assert "sess-1" not in manager._tasks

        # resume → 카탈로그에서 복원
        task = await manager.create_task(prompt="continue", agent_session_id="sess-1")
        assert task.status == TaskStatus.RUNNING
        assert task.resume_session_id == "claude-1"
        assert "sess-1" in manager._tasks

    async def test_add_intervention_evicted_session_auto_resume(self, manager: TaskManager):
        """퇴거된 세션에 개입 → 자동 resume"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.complete_task("sess-1", "done")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()

        # add_intervention → 자동 resume
        result = await manager.add_intervention("sess-1", "이어서", "user1")
        assert result["auto_resumed"] is True
        assert "sess-1" in manager._tasks


class TestStartupEviction:
    async def test_non_running_sessions_evicted_at_startup(self, manager: TaskManager):
        """서버 기동 시 비실행 세션은 _tasks에서 즉시 퇴거"""
        # 수동으로 _tasks에 세션 추가 (load 시뮬레이션)
        from soul_server.service.task_models import Task

        manager._tasks["sess-run"] = Task(
            agent_session_id="sess-run", prompt="running", status=TaskStatus.RUNNING
        )
        manager._tasks["sess-done"] = Task(
            agent_session_id="sess-done", prompt="done", status=TaskStatus.COMPLETED
        )
        manager._tasks["sess-err"] = Task(
            agent_session_id="sess-err", prompt="error", status=TaskStatus.ERROR
        )

        # 카탈로그 빌드 + 퇴거 (load()의 핵심 로직)
        await manager._catalog.build_from_tasks(manager._tasks)

        evicted_ids = [
            sid for sid, task in manager._tasks.items()
            if task.status != TaskStatus.RUNNING
        ]
        for sid in evicted_ids:
            del manager._tasks[sid]

        # running만 메모리에 남음
        assert "sess-run" in manager._tasks
        assert "sess-done" not in manager._tasks
        assert "sess-err" not in manager._tasks

        # 카탈로그에는 모두 존재
        assert manager._catalog.get("sess-run") is not None
        assert manager._catalog.get("sess-done") is not None
        assert manager._catalog.get("sess-err") is not None


class TestGetStats:
    async def test_stats_include_eviction_info(self, manager: TaskManager):
        """통계에 퇴거 관련 정보 포함"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.complete_task("sess-1", "done")

        stats = manager.get_stats()
        assert stats["total_in_memory"] == 2
        assert stats["total_in_catalog"] == 2
        assert stats["running"] == 1
        assert stats["completed"] == 1
        assert stats["eviction_candidates"] == 1
