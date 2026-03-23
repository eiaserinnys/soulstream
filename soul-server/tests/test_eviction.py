"""
test_eviction - TaskManager 세션 퇴거 + DB 통합 테스트
"""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, call

import pytest

from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_models import TaskStatus, utc_now


def _make_mock_db():
    db = MagicMock()
    db._pool = AsyncMock()
    db.node_id = "test-node"
    db.upsert_session = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.update_session_status = AsyncMock()
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
    db.get_default_folder = AsyncMock(return_value={"id": "claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0})
    db.assign_session_to_folder = AsyncMock()
    db.create_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    db.update_last_message = AsyncMock()
    db.search_events = AsyncMock(return_value=[])
    db.DEFAULT_FOLDERS = {"claude": "⚙️ 클로드 코드 세션", "llm": "⚙️ LLM 세션"}
    return db


def _find_upsert_call(mock_db, session_id, **expected_kwargs):
    """Find an upsert_session call for the given session_id and verify kwargs."""
    for c in mock_db.upsert_session.call_args_list:
        if c.args and c.args[0] == session_id:
            for key, value in expected_kwargs.items():
                if c.kwargs.get(key) != value:
                    break
            else:
                return c
    return None


@pytest.fixture
def manager():
    """Mock DB를 가진 TaskManager (짧은 TTL)"""
    m = TaskManager(session_db=_make_mock_db(), eviction_ttl=1)  # 1초 TTL
    yield m
    # 퇴거 루프가 있으면 취소
    if m._eviction_task and not m._eviction_task.done():
        m._eviction_task.cancel()
    set_task_manager(None)


class TestCatalogIntegration:
    async def test_create_task_registers_in_db(self, manager: TaskManager):
        """create_task()가 DB에 세션을 등록"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1", client_id="bot")

        upsert_call = _find_upsert_call(
            manager._db, "sess-1", status="running"
        )
        assert upsert_call is not None
        assert upsert_call.kwargs["prompt"] == "hello"
        assert upsert_call.kwargs["client_id"] == "bot"

    async def test_complete_task_updates_db(self, manager: TaskManager):
        """complete_task()가 DB 상태를 업데이트"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", result="result", claude_session_id="claude-1")

        upsert_call = _find_upsert_call(
            manager._db, "sess-1", status="completed"
        )
        assert upsert_call is not None
        assert upsert_call.kwargs["claude_session_id"] == "claude-1"
        assert upsert_call.kwargs.get("updated_at") is not None

    async def test_error_task_updates_db(self, manager: TaskManager):
        """error_task()가 DB 상태를 업데이트"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", error="boom")

        upsert_call = _find_upsert_call(
            manager._db, "sess-1", status="error"
        )
        assert upsert_call is not None
        assert upsert_call.kwargs.get("updated_at") is not None

    async def test_get_all_sessions_from_db(self, manager: TaskManager):
        """get_all_sessions()가 DB 기반 결과를 반환"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.finalize_task("sess-1", result="done")

        # Mock DB의 get_all_sessions가 반환할 데이터 설정
        manager._db.get_all_sessions.return_value = ([
            {
                "session_id": "sess-1",
                "status": "completed",
                "prompt": "hello",
                "client_id": None,
                "claude_session_id": None,
                "session_type": "claude",
                "last_event_id": 0,
                "last_read_event_id": 0,
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:01:00+00:00",
                "last_message": None,
                "name": None,
            },
            {
                "session_id": "sess-2",
                "status": "running",
                "prompt": "world",
                "client_id": None,
                "claude_session_id": None,
                "session_type": "claude",
                "last_event_id": 0,
                "last_read_event_id": 0,
                "created_at": "2026-01-01T00:00:01+00:00",
                "updated_at": "2026-01-01T00:00:01+00:00",
                "last_message": None,
                "name": None,
            },
        ], 2)

        sessions, total = await manager.get_all_sessions()
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
        await manager.finalize_task("sess-1", result="done")

        assert "sess-1" in manager._eviction_candidates

    async def test_eviction_check_removes_expired(self, manager: TaskManager):
        """TTL 만료된 세션이 _tasks에서 제거"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", result="done")

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

    async def test_evicted_session_still_in_db(self, manager: TaskManager):
        """퇴거된 세션은 DB에 여전히 존재 (delete_session이 호출되지 않음)"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", result="done")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()

        # _tasks에는 없지만 DB에서 삭제되지 않음
        assert "sess-1" not in manager._tasks
        manager._db.delete_session.assert_not_called()

        # DB에 completed 상태로 upsert된 기록이 있음
        upsert_call = _find_upsert_call(manager._db, "sess-1", status="completed")
        assert upsert_call is not None

    async def test_evicted_session_loadable_via_get_task(self, manager: TaskManager):
        """퇴거된 세션을 get_task()로 조회 가능 (on-demand 로드)"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1", client_id="bot")
        await manager.finalize_task("sess-1", result="done", claude_session_id="claude-1")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()

        # Mock DB가 get_session에서 반환할 데이터 설정
        manager._db.get_session.return_value = {
            "session_id": "sess-1",
            "status": "completed",
            "prompt": "hello",
            "client_id": "bot",
            "claude_session_id": "claude-1",
            "session_type": "claude",
            "last_event_id": 0,
            "last_read_event_id": 0,
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:01:00+00:00",
        }

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
        await manager.finalize_task("sess-1", result="done")

        original_expiry = manager._eviction_candidates["sess-1"]

        # get_task로 접근 → TTL 갱신
        await asyncio.sleep(0.1)
        await manager.get_task("sess-1")

        new_expiry = manager._eviction_candidates["sess-1"]
        assert new_expiry > original_expiry

    async def test_resume_removes_from_eviction_candidates(self, manager: TaskManager):
        """resume 시 퇴거 후보에서 제거"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", result="done")
        assert "sess-1" in manager._eviction_candidates

        # resume
        await manager.create_task(prompt="continue", agent_session_id="sess-1")
        assert "sess-1" not in manager._eviction_candidates

    async def test_resume_evicted_session(self, manager: TaskManager):
        """퇴거된 세션의 resume"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", result="done", claude_session_id="claude-1")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()
        assert "sess-1" not in manager._tasks

        # Mock DB가 get_session에서 반환할 데이터 설정 (resume에서 _load_evicted_task 호출)
        manager._db.get_session.return_value = {
            "session_id": "sess-1",
            "status": "completed",
            "prompt": "hello",
            "client_id": None,
            "claude_session_id": "claude-1",
            "session_type": "claude",
            "last_event_id": 0,
            "last_read_event_id": 0,
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:01:00+00:00",
        }

        # resume → DB에서 복원
        task = await manager.create_task(prompt="continue", agent_session_id="sess-1")
        assert task.status == TaskStatus.RUNNING
        assert task.resume_session_id == "claude-1"
        assert "sess-1" in manager._tasks

    async def test_add_intervention_evicted_session_auto_resume(self, manager: TaskManager):
        """퇴거된 세션에 개입 → 자동 resume"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.finalize_task("sess-1", result="done")

        # 강제 퇴거
        manager._eviction_candidates["sess-1"] = time.time() - 1
        manager._run_eviction_check()

        # Mock DB가 get_session에서 반환할 데이터 설정
        manager._db.get_session.return_value = {
            "session_id": "sess-1",
            "status": "completed",
            "prompt": "hello",
            "client_id": None,
            "claude_session_id": None,
            "session_type": "claude",
            "last_event_id": 0,
            "last_read_event_id": 0,
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:01:00+00:00",
        }

        # add_intervention → 자동 resume
        result = await manager.add_intervention("sess-1", "이어서", "user1")
        assert result["auto_resumed"] is True
        assert "sess-1" in manager._tasks


class TestStartupEviction:
    async def test_non_running_sessions_evicted_at_startup(self, manager: TaskManager):
        """서버 기동 시 비실행 세션은 _tasks에 로드되지 않음 (DB에서 온디맨드 조회)"""
        from soul_server.service.task_models import Task

        # Mock DB가 load()에서 반환할 데이터 설정
        manager._db.get_all_sessions.return_value = ([
            {
                "session_id": "sess-run",
                "status": "running",
                "prompt": "running",
                "client_id": None,
                "claude_session_id": None,
                "session_type": "claude",
                "last_event_id": 0,
                "last_read_event_id": 0,
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
                "was_running_at_shutdown": 1,
            },
            {
                "session_id": "sess-done",
                "status": "completed",
                "prompt": "done",
                "client_id": None,
                "claude_session_id": None,
                "session_type": "claude",
                "last_event_id": 0,
                "last_read_event_id": 0,
                "created_at": "2026-01-01T00:00:01+00:00",
                "updated_at": "2026-01-01T00:00:01+00:00",
            },
            {
                "session_id": "sess-err",
                "status": "error",
                "prompt": "error",
                "client_id": None,
                "claude_session_id": None,
                "session_type": "claude",
                "last_event_id": 0,
                "last_read_event_id": 0,
                "created_at": "2026-01-01T00:00:02+00:00",
                "updated_at": "2026-01-01T00:00:02+00:00",
            },
        ], 3)

        loaded = await manager.load()

        # running만 메모리에 남음
        assert "sess-run" in manager._tasks
        assert "sess-done" not in manager._tasks
        assert "sess-err" not in manager._tasks

        # running 1개만 로드됨
        assert loaded == 1

        # 퇴거 루프 정리
        if manager._eviction_task and not manager._eviction_task.done():
            manager._eviction_task.cancel()


class TestGetStats:
    async def test_stats_include_eviction_info(self, manager: TaskManager):
        """통계에 퇴거 관련 정보 포함"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.finalize_task("sess-1", result="done")

        # Mock DB가 get_all_sessions에서 반환할 총 수 설정
        manager._db.get_all_sessions.return_value = ([], 2)

        stats = await manager.get_stats()
        assert stats["total_in_memory"] == 2
        assert stats["total_in_db"] == 2
        assert stats["running"] == 1
        assert stats["completed"] == 1
        assert stats["eviction_candidates"] == 1
