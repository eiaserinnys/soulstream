"""TaskExecutor parent_event_id 타입 체인 int 일관성 단위 테스트

task_executor.py의 parent_event_id 흐름이 전체적으로 int 타입을 유지하는지 검증한다.
Pydantic Optional[int]로 스키마가 확정된 이후, 이 타입 체인이 깨지면
event_dict["parent_event_id"]가 str로 새어 들어가 DB INTEGER 컬럼에 저장 실패한다.

검증 지점:
1. `_persist_initial_messages` 반환값이 Optional[int]
2. `_consume_event_stream`에서 request_id_ref[0]가 int일 때 fallback이 int로 채움
3. intervention 이후 request_id_ref[0]가 int (str 아님)
4. complete/error 이벤트의 parent_event_id가 int로 DB에 기록됨
"""

import json
from contextlib import asynccontextmanager
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.models.schemas import (
    CompleteEvent,
    ErrorEvent,
    TextStartSSEEvent,
    ThinkingSSEEvent,
    ToolStartSSEEvent,
)
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


# === Helpers (test_task_executor_parent_event.py와 동일 패턴) ===


class FakeResourceManager:
    @asynccontextmanager
    async def acquire(self, timeout: float = 5.0):
        yield


class FakeClaudeRunner:
    workspace_dir = "/fake/workspace"

    def __init__(self, events):
        self._events = events

    async def execute(self, **kwargs):
        on_intervention_sent = kwargs.get("on_intervention_sent")
        for event in self._events:
            if isinstance(event, tuple) and event[0] == "INTERVENTION":
                _, user, text = event
                if on_intervention_sent:
                    await on_intervention_sent(user, text)
                continue
            yield event


def _make_task(session_id: str = "sess-int-chain") -> Task:
    return Task(
        agent_session_id=session_id,
        prompt="test",
        client_id="test-bot",
        status=TaskStatus.RUNNING,
    )


def _make_mock_session_db():
    """이벤트를 인메모리로 추적하는 PostgresSessionDB mock."""
    db = AsyncMock(spec=PostgresSessionDB)
    _events: dict = {}
    _next_ids: dict = {}

    async def _append_event(session_id, event_type, payload, searchable_text, created_at):
        if session_id not in _next_ids:
            _next_ids[session_id] = 1
        event_id = _next_ids[session_id]
        _events.setdefault(session_id, []).append({
            "id": event_id,
            "session_id": session_id,
            "event_type": event_type,
            "payload": payload,
            "created_at": created_at,
        })
        _next_ids[session_id] = event_id + 1
        return event_id  # 반드시 int

    db.append_event = AsyncMock(side_effect=_append_event)
    db.upsert_session = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.update_last_message = AsyncMock()
    db._events = _events
    return db


def _make_executor(tasks: dict, session_db=None) -> tuple[TaskExecutor, list]:
    listener_manager = MagicMock()
    broadcast_calls: list = []

    async def capture(session_id, event_dict):
        broadcast_calls.append((session_id, event_dict))

    listener_manager.broadcast = AsyncMock(side_effect=capture)

    executor = TaskExecutor(
        tasks=tasks,
        listener_manager=listener_manager,
        get_intervention_func=AsyncMock(return_value=None),
        finalize_task_func=AsyncMock(),
        register_session_func=AsyncMock(),
        session_db=session_db,
    )
    return executor, broadcast_calls


# === Tests ===


class TestPersistInitialMessagesReturnType:
    """_persist_initial_messages 반환값이 Optional[int]임을 검증."""

    @pytest.mark.asyncio
    async def test_returns_int_when_db_present(self):
        """session_db가 있으면 user_message의 event_id(int)를 반환."""
        from soul_server.service.task_executor import _PreparedContext

        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor, _ = _make_executor(tasks, session_db=session_db)

        ctx = _PreparedContext(
            effective_system_prompt="sys",
            combined_context_items=[],
            assembled_prompt="assembled",
        )
        result = await executor._persist_initial_messages(task, ctx)

        assert result is not None
        assert isinstance(result, int), (
            f"_persist_initial_messages는 int를 반환해야 함. 실제 타입: {type(result).__name__}"
        )
        # system_message(id=1) + user_message(id=2) 저장 → user_message id 반환
        assert result == 2

    @pytest.mark.asyncio
    async def test_returns_none_when_db_absent(self):
        """session_db가 없으면 None을 반환 (Optional[int])."""
        from soul_server.service.task_executor import _PreparedContext

        task = _make_task()
        tasks = {task.agent_session_id: task}
        executor, _ = _make_executor(tasks, session_db=None)

        ctx = _PreparedContext(assembled_prompt="x")
        result = await executor._persist_initial_messages(task, ctx)

        assert result is None


class TestRequestIdRefIntTypeChain:
    """request_id_ref[0]가 체인 전체에서 int 타입을 유지하는지 검증."""

    @pytest.mark.asyncio
    async def test_initial_request_id_is_int(self):
        """_run_execution 초기에 request_id_ref[0]가 int로 설정된다."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # fallback이 실제로 동작하는지 확인하기 위해 parent_event_id=None인 complete 이벤트 사용
        runner = FakeClaudeRunner(events=[CompleteEvent(result="ok", parent_event_id=None)])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)

        await executor._run_execution(task, runner, FakeResourceManager())

        # complete 이벤트의 parent_event_id가 int로 채워짐
        complete_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_broadcasts) == 1
        _, complete_dict = complete_broadcasts[0]

        parent_id = complete_dict["parent_event_id"]
        assert parent_id is not None
        assert isinstance(parent_id, int), (
            f"fallback에서 채운 parent_event_id는 int여야 함. 실제: {type(parent_id).__name__}"
        )
        # user_message = id 1 (system_prompt 없으므로)
        assert parent_id == 1

    @pytest.mark.asyncio
    async def test_request_id_ref_int_after_intervention(self):
        """intervention 이후 request_id_ref[0]가 int (str 아님)."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # complete(parent=None) → intervention → complete(parent=None)
        runner = FakeClaudeRunner(events=[
            CompleteEvent(result="first", parent_event_id=None),
            ("INTERVENTION", "user1", "continue please"),
            CompleteEvent(result="second", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        complete_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_broadcasts) == 2

        first_parent = complete_broadcasts[0][1]["parent_event_id"]
        second_parent = complete_broadcasts[1][1]["parent_event_id"]

        # 두 parent_event_id 모두 int
        assert isinstance(first_parent, int), (
            f"첫 번째 complete parent_event_id는 int여야 함. 실제: {type(first_parent).__name__}"
        )
        assert isinstance(second_parent, int), (
            f"intervention 이후 complete parent_event_id는 int여야 함. 실제: {type(second_parent).__name__}"
        )

        # 순서: user_message(1) → first_complete(2) → intervention_user_message(3) → second_complete(4)
        assert first_parent == 1
        assert second_parent == 3  # intervention event_id로 갱신됨
        assert second_parent > first_parent


class TestFallbackFillsIntNotStr:
    """L325-L326 fallback에서 int만 채워지는지 검증 (str 오염 방지)."""

    @pytest.mark.asyncio
    async def test_thinking_event_fallback_fills_int(self):
        """ThinkingSSEEvent.parent_event_id=None → int로 채워짐."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ThinkingSSEEvent(thinking="생각 중", timestamp=1.0, parent_event_id=None),
            CompleteEvent(result="done", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        thinking_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "thinking"
        ]
        assert len(thinking_broadcasts) == 1
        _, thinking_dict = thinking_broadcasts[0]

        parent_id = thinking_dict["parent_event_id"]
        assert isinstance(parent_id, int)
        assert parent_id == 1

    @pytest.mark.asyncio
    async def test_tool_start_fallback_fills_int(self):
        """ToolStartSSEEvent.parent_event_id=None → int로 채워짐."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Read", timestamp=1.0, parent_event_id=None),
            CompleteEvent(result="done", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        tool_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "tool_start"
        ]
        assert len(tool_broadcasts) == 1
        _, tool_dict = tool_broadcasts[0]

        parent_id = tool_dict["parent_event_id"]
        assert isinstance(parent_id, int)
        assert parent_id == 1

    @pytest.mark.asyncio
    async def test_preexisting_int_parent_preserved(self):
        """parent_event_id가 이미 int면 덮어쓰지 않는다 (서브에이전트 경로)."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ToolStartSSEEvent(tool_name="Bash", timestamp=1.0, parent_event_id=777),
            CompleteEvent(result="done", parent_event_id=None),
        ])
        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        tool_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "tool_start"
        ]
        _, tool_dict = tool_broadcasts[0]
        parent_id = tool_dict["parent_event_id"]
        assert isinstance(parent_id, int)
        assert parent_id == 777  # 기존 int 값 보존


class TestNoStringLeakIntoDB:
    """DB에 기록되는 parent_event_id가 int로 JSON 직렬화되는지 검증."""

    @pytest.mark.asyncio
    async def test_persisted_parent_event_id_is_int_in_payload(self):
        """append_event로 기록된 payload의 parent_event_id가 int로 직렬화된다."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            CompleteEvent(result="done", parent_event_id=None),
        ])
        executor, _ = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # 저장된 complete 이벤트 찾기
        stored = session_db._events.get(task.agent_session_id, [])
        complete_rows = [
            row for row in stored
            if json.loads(row["payload"]).get("type") == "complete"
        ]
        assert len(complete_rows) == 1
        payload = json.loads(complete_rows[0]["payload"])

        # JSON에서 역직렬화된 parent_event_id가 int (Python에서 str "1"이 아니라 int 1)
        assert isinstance(payload["parent_event_id"], int), (
            f"DB payload의 parent_event_id는 int여야 함. 실제: {type(payload['parent_event_id']).__name__}"
        )

    @pytest.mark.asyncio
    async def test_error_event_persisted_with_int_parent(self):
        """ErrorEvent의 parent_event_id도 int로 기록된다."""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[
            ErrorEvent(message="boom", parent_event_id=None),
        ])
        executor, _ = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        stored = session_db._events.get(task.agent_session_id, [])
        error_rows = [
            row for row in stored
            if json.loads(row["payload"]).get("type") == "error"
        ]
        assert len(error_rows) == 1
        payload = json.loads(error_rows[0]["payload"])

        assert isinstance(payload["parent_event_id"], int)
        assert payload["parent_event_id"] == 1
