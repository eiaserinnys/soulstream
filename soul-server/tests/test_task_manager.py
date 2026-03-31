"""
test_task_manager - 세션 CRUD, 충돌 감지, cleanup, agent_session_id 기반 테스트

현재 API는 agent_session_id를 단일 primary key로 사용합니다.
"""

import asyncio
from datetime import timedelta
from pathlib import Path

import pytest

from unittest.mock import AsyncMock

from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_manager import TaskManager, set_task_manager
from soul_server.service.task_models import (
    Task,
    TaskStatus,
    TaskConflictError,
    TaskNotFoundError,
    utc_now,
)


def _make_mock_session_db():
    """PostgresSessionDB의 AsyncMock을 생성한다. 상태를 추적하는 인메모리 mock."""
    db = AsyncMock(spec=PostgresSessionDB)
    _sessions = {}
    _folders = {
        "claude": {"id": "claude", "name": "⚙️ 클로드 코드 세션", "sort_order": 0},
        "llm": {"id": "llm", "name": "⚙️ LLM 세션", "sort_order": 0},
    }

    async def _upsert_session(session_id, **fields):
        if session_id not in _sessions:
            _sessions[session_id] = {"session_id": session_id, "metadata": [], "last_event_id": 0, "last_read_event_id": 0}
        _sessions[session_id].update(fields)
        # Ensure created_at/updated_at are datetime objects (matching real DB behavior)
        for ts_field in ("created_at", "updated_at"):
            if ts_field in fields and isinstance(fields[ts_field], str):
                from datetime import datetime
                _sessions[session_id][ts_field] = datetime.fromisoformat(fields[ts_field])

    async def _get_session(session_id):
        if session_id not in _sessions:
            return None
        return dict(_sessions[session_id])

    async def _get_all_sessions(offset=0, limit=0, session_type=None, folder_id=None, node_id=None, status=None):
        items = list(_sessions.values())
        if session_type:
            items = [s for s in items if s.get("session_type") == session_type]
        if folder_id:
            items = [s for s in items if s.get("folder_id") == folder_id]
        if node_id:
            items = [s for s in items if s.get("node_id") == node_id]
        return items, len(items)

    async def _get_default_folder(name):
        for f in _folders.values():
            if f["name"] == name:
                return f
        return None

    async def _assign_session_to_folder(session_id, folder_id):
        if session_id in _sessions:
            _sessions[session_id]["folder_id"] = folder_id

    async def _get_catalog():
        folder_list = [
            {"id": f["id"], "name": f["name"], "sortOrder": f.get("sort_order", 0)}
            for f in _folders.values()
        ]
        sessions = {}
        for sid, s in _sessions.items():
            sessions[sid] = {
                "folderId": s.get("folder_id"),
                "displayName": s.get("display_name"),
            }
        return {"folders": folder_list, "sessions": sessions}

    async def _ensure_default_folders():
        pass

    async def _create_folder(folder_id, name, sort_order=0):
        _folders[folder_id] = {"id": folder_id, "name": name, "sort_order": sort_order}

    async def _get_all_folders():
        return list(_folders.values())

    async def _register_session_initial(session_id, node_id, agent_id=None, claude_session_id=None, session_type="claude", prompt=None, client_id=None, status="running", created_at=None, updated_at=None, caller_session_id=None):
        _sessions[session_id] = {
            "session_id": session_id,
            "node_id": node_id,
            "agent_id": agent_id,
            "claude_session_id": claude_session_id,
            "session_type": session_type,
            "prompt": prompt,
            "client_id": client_id,
            "status": status,
            "caller_session_id": caller_session_id,
            "metadata": [],
            "last_event_id": 0,
            "last_read_event_id": 0,
        }

    async def _update_session(session_id, **fields):
        if session_id in _sessions:
            _sessions[session_id].update(fields)
            # Ensure created_at/updated_at are datetime objects (matching real DB behavior)
            for ts_field in ("created_at", "updated_at"):
                if ts_field in fields and isinstance(fields[ts_field], str):
                    from datetime import datetime
                    _sessions[session_id][ts_field] = datetime.fromisoformat(fields[ts_field])

    async def _set_claude_session_id(session_id, claude_session_id):
        if session_id not in _sessions:
            return
        existing = _sessions[session_id].get("claude_session_id")
        if existing is None:
            _sessions[session_id]["claude_session_id"] = claude_session_id
        elif existing == claude_session_id:
            pass  # no-op (idempotent)
        else:
            raise ValueError(
                f"claude_session_id immutability violation: "
                f"session_id={session_id}, existing={existing!r}, new={claude_session_id!r}"
            )

    db.upsert_session = AsyncMock(side_effect=_upsert_session)
    db.register_session_initial = AsyncMock(side_effect=_register_session_initial)
    db.set_claude_session_id = AsyncMock(side_effect=_set_claude_session_id)
    db.update_session = AsyncMock(side_effect=_update_session)
    db.get_session = AsyncMock(side_effect=_get_session)
    db.get_all_sessions = AsyncMock(side_effect=_get_all_sessions)
    db.get_default_folder = AsyncMock(side_effect=_get_default_folder)
    db.assign_session_to_folder = AsyncMock(side_effect=_assign_session_to_folder)
    db.get_catalog = AsyncMock(side_effect=_get_catalog)
    db.ensure_default_folders = AsyncMock(side_effect=_ensure_default_folders)
    db.create_folder = AsyncMock(side_effect=_create_folder)
    db.get_all_folders = AsyncMock(side_effect=_get_all_folders)
    db.append_event = AsyncMock(return_value=1)
    db.read_events = AsyncMock(return_value=[])
    db.update_last_read_event_id = AsyncMock(return_value=True)
    db.append_metadata = AsyncMock()
    db.update_session_status = AsyncMock()
    db.node_id = "test-node"
    return db


@pytest.fixture
def manager():
    """AsyncMock PostgresSessionDB를 사용하는 TaskManager"""
    db = _make_mock_session_db()
    m = TaskManager(session_db=db)
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
        await manager.finalize_task("sess-1", result="done")

        task2 = await manager.create_task(
            prompt="new prompt",
            agent_session_id="sess-1",
        )
        assert task2.prompt == "new prompt"
        assert task2.status == TaskStatus.RUNNING
        # 같은 agent_session_id가 재활성화됨
        assert task2.agent_session_id == "sess-1"

    async def test_resume_preserves_profile_id_when_none_passed(self, manager):
        """resume 시 profile_id=None을 전달하면 기존 profile_id가 유지된다."""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
            profile_id="profile-abc",
        )
        await manager.finalize_task("sess-1", result="done")

        # profile_id를 전달하지 않고 resume
        task2 = await manager.create_task(
            prompt="resume prompt",
            agent_session_id="sess-1",
            profile_id=None,
        )
        # 기존 profile_id가 유지되어야 한다
        assert task2.profile_id == "profile-abc"

    async def test_resume_updates_profile_id_when_new_value_passed(self, manager):
        """resume 시 새 profile_id를 명시하면 기존 값이 덮어써진다."""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
            profile_id="profile-old",
        )
        await manager.finalize_task("sess-1", result="done")

        task2 = await manager.create_task(
            prompt="resume prompt",
            agent_session_id="sess-1",
            profile_id="profile-new",
        )
        assert task2.profile_id == "profile-new"


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
        await manager.finalize_task("sess-1", result="done")

        running = manager.get_running_tasks()
        assert len(running) == 1
        assert running[0].agent_session_id == "sess-2"

    async def test_get_all_sessions(self, manager):
        """전체 세션 목록 조회."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.register_session("claude-1", "sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.register_session("claude-2", "sess-2")
        await manager.finalize_task("sess-1", result="done")

        sessions, total = await manager.get_all_sessions()
        assert len(sessions) == 2
        assert total == 2


class TestCompleteTask:
    async def test_complete_basic(self, manager):
        """기본 세션 완료 (finalize_task result=)"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.finalize_task("sess-1", result="result")

        assert task is not None
        assert task.status == TaskStatus.COMPLETED
        assert task.result == "result"
        assert task.completed_at is not None

    async def test_complete_with_session_id(self, manager):
        """claude_session_id 포함 완료"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.finalize_task(
            "sess-1", result="result", claude_session_id="claude-sess-1"
        )
        assert task.claude_session_id == "claude-sess-1"

    async def test_complete_nonexistent(self, manager):
        """존재하지 않는 세션 완료 시도"""
        task = await manager.finalize_task("nonexistent", result="result")
        assert task is None


class TestErrorTask:
    async def test_error_basic(self, manager):
        """기본 세션 에러 처리 (finalize_task error=)"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.finalize_task("sess-1", error="something broke")

        assert task is not None
        assert task.status == TaskStatus.ERROR
        assert task.error == "something broke"
        assert task.completed_at is not None

    async def test_error_nonexistent(self, manager):
        """존재하지 않는 세션 에러 시도"""
        task = await manager.finalize_task("nonexistent", error="error")
        assert task is None


class TestFinalizeTask:
    """finalize_task() 동작 검증.

    finalize_task()는 complete_task() / error_task()의 통합 대체제이며,
    양쪽과 동일한 부수 효과(_unregister_claude_session 호출)를 가져야 한다.
    현재 코드는 _unregister_claude_session을 호출하지 않으므로 이 테스트들은 RED이다.
    Phase 2 수정 후 GREEN이 된다.
    """

    async def test_finalize_result_sets_completed_status(self, manager):
        """result= 전달 시 COMPLETED 상태로 전환된다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.finalize_task("sess-1", result="done")

        assert task is not None
        assert task.status == TaskStatus.COMPLETED
        assert task.result == "done"
        assert task.completed_at is not None

    async def test_finalize_error_sets_error_status(self, manager):
        """error= 전달 시 ERROR 상태로 전환된다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        task = await manager.finalize_task("sess-1", error="something broke")

        assert task is not None
        assert task.status == TaskStatus.ERROR
        assert task.error == "something broke"
        assert task.completed_at is not None

    async def test_finalize_result_unregisters_claude_session(self, manager):
        """finalize_task(result=) 호출 시 claude_session_id가 인덱스에서 제거된다.

        complete_task()와 동일한 _unregister_claude_session 부수 효과가 있어야 한다.
        현재 finalize_task()에는 이 호출이 없으므로 RED (assertion 실패).
        Phase 2에서 추가되면 GREEN이 된다.
        """
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        # claude_session_id를 인덱스에 등록
        manager._session_index["claude-abc"] = "sess-1"
        assert "claude-abc" in manager._session_index

        await manager.finalize_task("sess-1", result="done")

        # _unregister_claude_session이 호출되었으면 인덱스에서 제거되어야 한다
        assert "claude-abc" not in manager._session_index

    async def test_finalize_error_unregisters_claude_session(self, manager):
        """finalize_task(error=) 호출 시 claude_session_id가 인덱스에서 제거된다.

        error_task()와 동일한 _unregister_claude_session 부수 효과가 있어야 한다.
        현재 finalize_task()에는 이 호출이 없으므로 RED (assertion 실패).
        Phase 2에서 추가되면 GREEN이 된다.
        """
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        manager._session_index["claude-abc"] = "sess-1"
        assert "claude-abc" in manager._session_index

        await manager.finalize_task("sess-1", error="failed")

        assert "claude-abc" not in manager._session_index

    async def test_finalize_nonexistent_returns_none(self, manager):
        """존재하지 않는 세션에 finalize_task 호출 시 None을 반환한다."""
        task = await manager.finalize_task("nonexistent", result="done")
        assert task is None

    async def test_finalize_notifies_caller_session_on_result(self, manager):
        """caller_session_id가 있으면 완료 시 caller 세션의 intervention_queue에 메시지가 추가된다."""
        # caller 세션 생성
        await manager.create_task(prompt="parent work", agent_session_id="sess-caller")
        # 서브 세션 생성 (caller_session_id 지정)
        await manager.create_task(
            prompt="sub work",
            agent_session_id="sess-child",
            caller_session_id="sess-caller",
        )

        await manager.finalize_task("sess-child", result="sub task done")

        # caller 세션의 intervention_queue에 메시지가 추가되어 있어야 한다
        caller_task = manager._tasks.get("sess-caller")
        assert caller_task is not None
        assert not caller_task.intervention_queue.empty()
        iv = caller_task.intervention_queue.get_nowait()
        assert "sess-child" in iv["text"]
        assert "sub task done" in iv["text"]
        assert iv["user"] == "agent"

    async def test_finalize_notifies_caller_session_on_error(self, manager):
        """caller_session_id가 있고 오류 완료 시에도 caller 세션에 notification이 전달된다."""
        await manager.create_task(prompt="parent work", agent_session_id="sess-caller")
        await manager.create_task(
            prompt="sub work",
            agent_session_id="sess-child",
            caller_session_id="sess-caller",
        )

        await manager.finalize_task("sess-child", error="something went wrong")

        caller_task = manager._tasks.get("sess-caller")
        assert caller_task is not None
        assert not caller_task.intervention_queue.empty()
        iv = caller_task.intervention_queue.get_nowait()
        assert "sess-child" in iv["text"]
        assert iv["user"] == "agent"

    async def test_finalize_no_notification_when_no_caller(self, manager):
        """caller_session_id가 없으면 intervention_queue에 메시지가 추가되지 않는다."""
        await manager.create_task(prompt="standalone work", agent_session_id="sess-solo")

        task = await manager.finalize_task("sess-solo", result="done alone")

        assert task is not None
        assert task.status.value == "completed"
        # sess-solo 자체의 큐에는 아무것도 없어야 한다
        solo_task = manager._tasks.get("sess-solo")
        assert solo_task is not None
        assert solo_task.intervention_queue.empty()

    async def test_finalize_caller_notification_does_not_deadlock(self, manager):
        """caller 세션 알림이 락 데드락을 일으키지 않는다 (타임아웃 내에 완료되어야 한다)."""
        import asyncio
        await manager.create_task(prompt="parent", agent_session_id="sess-parent")
        await manager.create_task(
            prompt="child",
            agent_session_id="sess-sub",
            caller_session_id="sess-parent",
        )

        # 5초 타임아웃 내에 완료되어야 한다 (데드락이면 타임아웃 발생)
        task = await asyncio.wait_for(
            manager.finalize_task("sess-sub", result="finished"),
            timeout=5.0,
        )
        assert task is not None


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
        await manager.finalize_task("sess-1", result="done")

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

    async def test_add_intervention_evicted_running_task_forced_to_interrupted(self, manager):
        """퇴거된 세션이 RUNNING 상태일 때 add_intervention이 INTERRUPTED로 강제 전환 후 resume한다."""
        # RUNNING 상태의 퇴거 Task 준비
        evicted_task = Task(agent_session_id="sess-evicted-running", prompt="old prompt")
        evicted_task.status = TaskStatus.RUNNING
        evicted_task.node_id = "test-node"

        # load_evicted_task가 RUNNING 상태 Task를 반환하도록 mock
        manager._eviction_manager.load_evicted_task = AsyncMock(return_value=evicted_task)

        result = await manager.add_intervention(
            agent_session_id="sess-evicted-running",
            text="이어서 해줘",
            user="user1",
        )

        # INTERRUPTED로 강제 전환 호출 확인
        manager._db.update_session_status.assert_called_with(
            "sess-evicted-running", TaskStatus.INTERRUPTED.value
        )
        # auto_resumed 응답 확인
        assert result["auto_resumed"] is True
        # create_task가 호출되어 세션이 재활성화됨 (TaskConflictError 없음)
        task = await manager.get_task("sess-evicted-running")
        assert task.status == TaskStatus.RUNNING
        assert task.prompt == "이어서 해줘"


class TestClaudeSessionIndex:
    async def test_register_and_get_by_claude_session(self, manager):
        """claude_session_id 인덱스 등록 및 조회"""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.register_session("claude-sess-abc", "sess-1")

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

        await manager.register_session("claude-abc", "sess-1")

        # register_session 후 즉시 설정되어 있어야 한다
        assert task.claude_session_id == "claude-abc"

    async def test_register_session_for_nonexistent_task_does_not_fail(self, manager):
        """존재하지 않는 agent_session_id에 register_session 해도 에러가 없다"""
        # 에러 없이 완료되어야 함
        await manager.register_session("claude-xyz", "sess-nonexistent")
        # 인덱스는 등록됨
        task = manager.get_task_by_claude_session("claude-xyz")
        assert task is None  # 태스크가 없으므로 None

    async def test_get_running_tasks_has_claude_session_id_after_register(self, manager):
        """register_session 후 get_running_tasks()로 조회한 태스크의 claude_session_id가 None이 아니다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.register_session("claude-abc", "sess-1")

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
        await manager.register_session("claude-abc", "sess-1")

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
        await manager.finalize_task("sess-1", result="result")

        # 오래된 세션이라도 삭제하지 않음
        task_ref = await manager.get_task("sess-1")
        task_ref.created_at = utc_now() - timedelta(hours=25)

        fixed = await manager.cleanup_orphaned_running(max_age_hours=24)
        assert fixed == 0

        task = await manager.get_task("sess-1")
        assert task is not None


class TestStats:
    async def test_stats(self, manager):
        """통계 조회."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.register_session("claude-1", "sess-1")
        await manager.create_task(prompt="world", agent_session_id="sess-2")
        await manager.register_session("claude-2", "sess-2")
        await manager.finalize_task("sess-1", result="done")

        stats = await manager.get_stats()
        assert stats["total_in_memory"] == 2
        assert stats["total_in_db"] == 2
        assert stats["running"] == 1
        assert stats["completed"] == 1
        assert stats["error"] == 0
        assert stats["eviction_candidates"] == 1


class TestFolderId:
    async def test_create_with_folder_id(self, manager):
        """folder_id 지정 시 create_task() 에서 해당 폴더에 세션이 배치된다."""
        # 커스텀 폴더 생성
        await manager._db.create_folder("custom-folder", "커스텀 폴더", sort_order=10)

        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
            folder_id="custom-folder",
        )
        await manager.register_session("claude-1", "sess-1")

        # DB에서 세션의 folder_id 확인
        session = await manager._db.get_session("sess-1")
        assert session["folder_id"] == "custom-folder"

    async def test_create_without_folder_id_uses_default(self, manager):
        """folder_id 미지정 시 create_task() 에서 session_type 기반 기본 폴더에 자동 배정된다."""
        await manager.create_task(
            prompt="hello",
            agent_session_id="sess-1",
        )
        await manager.register_session("claude-1", "sess-1")

        session = await manager._db.get_session("sess-1")
        assert session["folder_id"] is not None

        # 기본 폴더의 이름 확인
        folders = await manager._db.get_all_folders()
        folder_map = {f["id"]: f["name"] for f in folders}
        assigned_name = folder_map.get(session["folder_id"])
        assert assigned_name == "⚙️ 클로드 코드 세션"

    async def test_register_external_task_uses_default_folder(self, manager):
        """register_external_task는 folder_id 없이 기본 폴더에 배정된다"""
        task = Task(
            agent_session_id="ext-1",
            prompt="external",
            session_type="llm",
        )
        await manager.register_external_task(task)

        session = await manager._db.get_session("ext-1")
        assert session["folder_id"] is not None

        folders = await manager._db.get_all_folders()
        folder_map = {f["id"]: f["name"] for f in folders}
        assigned_name = folder_map.get(session["folder_id"])
        assert assigned_name == "⚙️ LLM 세션"


class TestLoad:
    async def test_load_filters_by_node_id(self, manager):
        """load()는 get_all_sessions()를 호출할 때 node_id 필터를 사용한다."""
        await manager.load()

        manager._db.get_all_sessions.assert_called_once()
        call_kwargs = manager._db.get_all_sessions.call_args
        # 키워드 인자로 node_id가 전달되었는지 확인
        assert call_kwargs.kwargs.get("node_id") == "test-node"

    async def test_load_transitions_shutdown_sessions_to_interrupted(self, manager):
        """was_running_at_shutdown=1인 running 세션은 interrupted로 전환되어 _tasks에 올라간다."""
        import datetime

        async def _get_all_with_shutdown(offset=0, limit=0, session_type=None, node_id=None):
            return [
                {
                    "session_id": "sess-shutdown",
                    "status": "running",
                    "was_running_at_shutdown": 1,
                    "prompt": "test prompt",
                    "client_id": None,
                    "claude_session_id": None,
                    "session_type": "claude",
                    "last_event_id": 0,
                    "last_read_event_id": 0,
                    "created_at": datetime.datetime.now(datetime.timezone.utc),
                    "node_id": "test-node",
                }
            ], 1

        manager._db.get_all_sessions.side_effect = _get_all_with_shutdown

        loaded = await manager.load()

        # DB에서 interrupted로 전환 호출 확인
        manager._db.update_session_status.assert_called_once_with(
            "sess-shutdown", TaskStatus.INTERRUPTED.value
        )
        # _tasks에 INTERRUPTED 상태로 올라갔는지 확인
        assert "sess-shutdown" in manager._tasks
        assert manager._tasks["sess-shutdown"].status == TaskStatus.INTERRUPTED
        assert loaded == 1

    async def test_load_zombie_sessions_become_interrupted(self, manager):
        """was_running_at_shutdown=0인 running 세션도 interrupted로 전환되고 _tasks에 올라간다."""
        import datetime

        async def _get_all_with_zombie(offset=0, limit=0, session_type=None, node_id=None):
            return [
                {
                    "session_id": "sess-zombie",
                    "status": "running",
                    "was_running_at_shutdown": 0,
                    "prompt": "zombie prompt",
                    "client_id": None,
                    "claude_session_id": None,
                    "session_type": "claude",
                    "last_event_id": 0,
                    "last_read_event_id": 0,
                    "created_at": datetime.datetime.now(datetime.timezone.utc),
                    "node_id": "test-node",
                }
            ], 1

        manager._db.get_all_sessions.side_effect = _get_all_with_zombie

        loaded = await manager.load()

        # DB에서 interrupted로 전환 호출 확인
        manager._db.update_session_status.assert_called_once_with(
            "sess-zombie", TaskStatus.INTERRUPTED.value
        )
        # _tasks에 INTERRUPTED 상태로 올라갔는지 확인
        assert "sess-zombie" in manager._tasks
        assert manager._tasks["sess-zombie"].status == TaskStatus.INTERRUPTED
        assert loaded == 1




class TestNodeIdGuard:
    """node_id 소속 검사 및 덮어쓰기 방지 테스트"""

    async def test_resume_different_node_raises_node_mismatch_error(self, manager):
        """다른 노드 소속 퇴거 세션 resume 시 NodeMismatchError 발생"""
        from unittest.mock import patch, AsyncMock as MockAsync
        from soul_server.service.task_models import Task, TaskStatus, NodeMismatchError

        # 다른 노드 소속의 퇴거 Task 준비
        evicted_task = Task(agent_session_id="sess-other", prompt="old")
        evicted_task.status = TaskStatus.COMPLETED
        evicted_task.node_id = "other-node"  # 다른 노드

        # _eviction_manager.load_evicted_task가 evicted_task를 반환하도록 mock
        with patch.object(
            manager._eviction_manager,
            "load_evicted_task",
            new_callable=lambda: lambda *a, **kw: MockAsync(return_value=evicted_task)(),
        ):
            manager._eviction_manager.load_evicted_task = MockAsync(return_value=evicted_task)
            with pytest.raises(NodeMismatchError) as exc_info:
                await manager.create_task(
                    prompt="resume attempt",
                    agent_session_id="sess-other",
                )

        err = exc_info.value
        assert err.session_node_id == "other-node"
        assert err.current_node_id == "test-node"

    async def test_resume_same_node_succeeds(self, manager):
        """같은 노드 소속 퇴거 세션 resume 시 정상 동작"""
        from unittest.mock import AsyncMock as MockAsync
        from soul_server.service.task_models import Task, TaskStatus

        evicted_task = Task(agent_session_id="sess-same", prompt="old")
        evicted_task.status = TaskStatus.COMPLETED
        evicted_task.node_id = "test-node"  # 동일 노드

        manager._eviction_manager.load_evicted_task = MockAsync(return_value=evicted_task)

        task = await manager.create_task(
            prompt="resume",
            agent_session_id="sess-same",
        )
        assert task.status == TaskStatus.RUNNING
        assert task.agent_session_id == "sess-same"

    async def test_resume_none_node_id_allowed(self, manager):
        """퇴거 세션의 node_id가 None이면 현재 노드에서 resume 허용 (하위 호환)"""
        from unittest.mock import AsyncMock as MockAsync
        from soul_server.service.task_models import Task, TaskStatus

        evicted_task = Task(agent_session_id="sess-legacy", prompt="old")
        evicted_task.status = TaskStatus.COMPLETED
        evicted_task.node_id = None  # node_id 없는 구버전 세션

        manager._eviction_manager.load_evicted_task = MockAsync(return_value=evicted_task)

        task = await manager.create_task(
            prompt="resume legacy",
            agent_session_id="sess-legacy",
        )
        assert task.status == TaskStatus.RUNNING

    async def test_resume_does_not_write_node_id_to_db(self, manager):
        """resume 시 update_session에 node_id를 전달하지 않는다 (불변 필드 — 최초 등록 시에만 기록)"""
        from unittest.mock import AsyncMock as MockAsync
        from soul_server.service.task_models import Task, TaskStatus

        evicted_task = Task(agent_session_id="sess-resume", prompt="old")
        evicted_task.status = TaskStatus.COMPLETED
        evicted_task.node_id = "test-node"

        manager._eviction_manager.load_evicted_task = MockAsync(return_value=evicted_task)

        # update_session 호출 시 인자를 캡처
        update_calls = []
        original_update = manager._db.update_session.side_effect

        async def capture_update(session_id, **kwargs):
            update_calls.append(kwargs)
            if original_update:
                await original_update(session_id, **kwargs)

        manager._db.update_session.side_effect = capture_update

        await manager.create_task(prompt="resume", agent_session_id="sess-resume")

        assert len(update_calls) == 1
        # resume(is_new=False) 시에는 node_id를 DB에 전달하지 않는다 (불변 필드 보호)
        assert "node_id" not in update_calls[0]

    async def test_new_session_sets_current_node_id(self, manager):
        """신규 세션 생성 시 task.node_id = self._db.node_id"""
        task = await manager.create_task(prompt="new session")
        assert task.node_id == "test-node"

        # upsert_session(deprecated)은 호출되지 않는다 — register_session_initial로 대체됨
        manager._db.upsert_session.assert_not_called()

    async def test_new_session_create_task_writes_node_id_to_db(self, manager):
        """신규 세션의 create_task 호출 시 node_id가 pending INSERT로 DB에 기록된다."""
        task = await manager.create_task(prompt="new session", agent_session_id="sess-new")

        # create_task가 register_session_initial을 node_id와 함께 호출했는지 확인
        call_kwargs = manager._db.register_session_initial.call_args.kwargs
        assert call_kwargs.get("node_id") == "test-node"
        assert call_kwargs.get("claude_session_id") is None  # pending 상태


class TestRegisterSessionDBWrite:
    """create_task/register_session의 DB 영속화 분리 검증"""

    async def test_create_task_pending_insert_and_register_session_set_claude_id(self, manager):
        """create_task가 pending INSERT, register_session이 claude_session_id를 확정한다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")

        # create_task → register_session_initial(claude_session_id=None, node_id=...)
        manager._db.register_session_initial.assert_called_once()
        init_kwargs = manager._db.register_session_initial.call_args.kwargs
        assert init_kwargs.get("claude_session_id") is None   # pending
        assert init_kwargs.get("node_id") == "test-node"

        # register_session → set_claude_session_id(session_id, claude_session_id)
        await manager.register_session("claude-abc", "sess-1")
        manager._db.set_claude_session_id.assert_called_once()
        set_args = manager._db.set_claude_session_id.call_args.args
        assert set_args[0] == "sess-1"
        assert set_args[1] == "claude-abc"

    async def test_register_session_sets_task_claude_session_id(self, manager):
        """register_session 호출 후 task.claude_session_id가 설정된다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.register_session("claude-xyz", "sess-1")

        task = manager._tasks.get("sess-1")
        assert task is not None
        assert task.claude_session_id == "claude-xyz"

    async def test_finalize_does_not_write_claude_session_id_to_db(self, manager):
        """finalize_task는 DB에 claude_session_id를 기록하지 않는다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        await manager.register_session("claude-abc", "sess-1")

        # 완료 처리
        manager._db.update_session.reset_mock()
        await manager.finalize_task("sess-1", result="done")

        # finalize 시 호출된 update_session에 claude_session_id가 없어야 한다
        # (update_session 자체가 불변 필드를 거부하므로 이 테스트는 방어적 검증)
        for call in manager._db.update_session.call_args_list:
            args, kwargs = call.args, call.kwargs
            if args[0] == "sess-1":
                assert "claude_session_id" not in kwargs, (
                    f"finalize_task가 DB에 claude_session_id를 기록했습니다: {kwargs}"
                )

    async def test_finalize_none_does_not_overwrite_claude_session_id(self, manager):
        """session 이벤트 없이 완료된 경우(None), DB의 claude_session_id가 덮어써지지 않는다."""
        await manager.create_task(prompt="hello", agent_session_id="sess-1")
        # register_session으로 claude_session_id 설정
        await manager.register_session("claude-abc", "sess-1")

        # finalize_task는 claude_session_id를 전달하지 않음 (무출력 종료 시나리오)
        await manager.finalize_task("sess-1", result="done")

        # task.claude_session_id는 여전히 register_session이 설정한 값이어야 한다
        # (finalize에서 None으로 덮어써지지 않음)
        task = manager._tasks.get("sess-1")
        assert task is not None
        assert task.claude_session_id == "claude-abc"
