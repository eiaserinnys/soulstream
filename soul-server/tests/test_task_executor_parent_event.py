"""TaskExecutor parent_event_id 통합 테스트

검증 항목:
1. 최상위 블록(parent_event_id=None)이 user_request_id로 채워지는지
2. 서브에이전트 블록(parent_event_id=toolu_*)은 변경되지 않는지
3. intervention 이후 이벤트가 새 user_request_id를 받는지
4. complete/error 이벤트에도 parent_event_id가 채워지는지
5. exception 경로의 에러 dict에도 parent_event_id가 포함되는지
6. 메타 이벤트(progress, session 등)는 parent_event_id가 없어 건너뛰는지
7. 세분화 이벤트(thinking, text_start 등)도 parent_event_id 채움 규칙이 적용되는지
"""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.models.schemas import (
    CompleteEvent,
    ErrorEvent,
    ProgressEvent,
    SessionEvent,
    ThinkingSSEEvent,
    TextStartSSEEvent,
    ToolStartSSEEvent,
)
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


# === Helpers ===


class FakeResourceManager:
    """테스트용 ResourceManager — acquire()가 즉시 성공"""

    @asynccontextmanager
    async def acquire(self, timeout: float = 5.0):
        yield


class FakeResourceManagerFailure:
    """acquire()에서 RuntimeError를 발생시키는 ResourceManager"""

    @asynccontextmanager
    async def acquire(self, timeout: float = 5.0):
        raise RuntimeError("No resources available")
        yield  # pragma: no cover


class FakeClaudeRunner:
    """테스트용 SoulEngineAdapter — 미리 정의된 이벤트를 yield"""

    workspace_dir = "/fake/workspace"

    def __init__(self, events, on_runner_ready_runner=None):
        self._events = events
        self._on_runner_ready_runner = on_runner_ready_runner

    async def execute(self, **kwargs):
        on_intervention_sent = kwargs.get("on_intervention_sent")
        on_runner_ready = kwargs.get("on_runner_ready")

        # runner ready 콜백
        if on_runner_ready and self._on_runner_ready_runner:
            on_runner_ready(self._on_runner_ready_runner)

        for event in self._events:
            if isinstance(event, tuple) and event[0] == "INTERVENTION":
                # intervention 시뮬레이션
                _, user, text = event
                if on_intervention_sent:
                    await on_intervention_sent(user, text)
                continue
            yield event


class FakeClaudeRunnerException:
    """execute() 내부에서 예외를 발생시키는 runner"""

    workspace_dir = "/fake/workspace"

    async def execute(self, **kwargs):
        raise RuntimeError("Runner exploded")
        yield  # pragma: no cover - async generator 형식 유지


def _make_task(session_id: str = "sess-test", prompt: str = "hello") -> Task:
    return Task(
        agent_session_id=session_id,
        prompt=prompt,
        client_id="test-bot",
        status=TaskStatus.RUNNING,
    )


def _make_mock_session_db():
    """이벤트를 인메모리로 추적하는 PostgresSessionDB mock을 생성"""
    db = AsyncMock(spec=PostgresSessionDB)
    _events = {}  # session_id -> list of {id, event_type, payload, ...}
    _next_ids = {}  # session_id -> next_id

    async def _append_event(session_id, event_type, payload, searchable_text, created_at):
        if session_id not in _next_ids:
            _next_ids[session_id] = 1
        event_id = _next_ids[session_id]
        if session_id not in _events:
            _events[session_id] = []
        _events[session_id].append({
            "id": event_id,
            "session_id": session_id,
            "event_type": event_type,
            "payload": payload,
            "searchable_text": searchable_text,
            "created_at": created_at,
        })
        _next_ids[session_id] = event_id + 1
        return event_id

    async def _read_events(session_id, after_id=0):
        events = _events.get(session_id, [])
        return [e for e in events if e["id"] > after_id]

    db.append_event = AsyncMock(side_effect=_append_event)
    db.read_events = AsyncMock(side_effect=_read_events)
    db.upsert_session = AsyncMock()
    db.get_session = AsyncMock(return_value=None)
    db.update_last_message = AsyncMock()
    db.extract_searchable_text = PostgresSessionDB.extract_searchable_text
    db._events = _events  # expose for test assertions
    return db


def _make_executor(
    tasks: dict,
    session_db: Optional[AsyncMock] = None,
) -> tuple[TaskExecutor, list]:
    """TaskExecutor와 broadcast를 캡처하는 listener_manager를 생성"""
    listener_manager = MagicMock()
    broadcast_calls = []

    async def capture_broadcast(session_id, event_dict):
        broadcast_calls.append((session_id, event_dict))

    listener_manager.broadcast = AsyncMock(side_effect=capture_broadcast)

    executor = TaskExecutor(
        tasks=tasks,
        listener_manager=listener_manager,
        get_intervention_func=AsyncMock(return_value=None),
        complete_task_func=AsyncMock(),
        error_task_func=AsyncMock(),
        register_session_func=MagicMock(),
        session_db=session_db,
    )

    return executor, broadcast_calls


# === Tests ===


class TestParentEventIdFilling:
    """parent_event_id가 None인 이벤트에 user_request_id가 채워지는지 검증"""

    @pytest.mark.asyncio
    async def test_complete_event_gets_user_request_id(self):
        """CompleteEvent.parent_event_id가 user_message의 event_id로 채워진다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        complete_event = CompleteEvent(
            result="done",
            claude_session_id="claude-1",
            parent_event_id=None,
        )
        runner = FakeClaudeRunner(events=[complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # broadcast된 이벤트 중 complete 찾기
        complete_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_broadcasts) == 1
        _, complete_dict = complete_broadcasts[0]

        # parent_event_id가 user_message의 event_id(문자열)로 채워져야 함
        assert complete_dict["parent_event_id"] is not None
        assert complete_dict["parent_event_id"] == "1"  # EventStore 첫 번째 이벤트 ID

    @pytest.mark.asyncio
    async def test_error_event_gets_user_request_id(self):
        """ErrorEvent.parent_event_id가 user_message의 event_id로 채워진다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        error_event = ErrorEvent(
            message="something failed",
            parent_event_id=None,
        )
        runner = FakeClaudeRunner(events=[error_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        error_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "error"
        ]
        assert len(error_broadcasts) == 1
        _, error_dict = error_broadcasts[0]
        assert error_dict["parent_event_id"] == "1"

    @pytest.mark.asyncio
    async def test_subagent_event_not_overwritten(self):
        """parent_event_id가 이미 설정된 이벤트(서브에이전트)는 변경하지 않는다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # 서브에이전트 이벤트: parent_event_id가 이미 toolu_AAA
        complete_event = CompleteEvent(
            result="subagent done",
            claude_session_id="claude-sub",
            parent_event_id="toolu_AAA",
        )
        runner = FakeClaudeRunner(events=[complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        complete_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_broadcasts) == 1
        _, complete_dict = complete_broadcasts[0]
        assert complete_dict["parent_event_id"] == "toolu_AAA"

    @pytest.mark.asyncio
    async def test_meta_events_have_no_parent_event_id(self):
        """progress, session 등 메타 이벤트는 parent_event_id 필드가 없으므로 건너뛴다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        progress_event = ProgressEvent(text="working...")
        session_event = SessionEvent(session_id="claude-sess-1", pid=1234)
        complete_event = CompleteEvent(result="done", parent_event_id=None)

        runner = FakeClaudeRunner(events=[progress_event, session_event, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # progress에는 parent_event_id가 없어야 함
        progress_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "progress"
        ]
        assert len(progress_broadcasts) == 1
        _, progress_dict = progress_broadcasts[0]
        assert "parent_event_id" not in progress_dict

        # session에도 parent_event_id가 없어야 함
        session_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "session"
        ]
        assert len(session_broadcasts) == 1
        _, session_dict = session_broadcasts[0]
        assert "parent_event_id" not in session_dict


class TestInterventionUpdatesUserRequestId:
    """intervention 이후 이벤트가 새 user_request_id를 받는지 검증"""

    @pytest.mark.asyncio
    async def test_events_after_intervention_get_new_user_request_id(self):
        """intervention 후 이벤트의 parent_event_id가 intervention의 event_id로 갱신된다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # 시퀀스: complete → intervention → complete
        first_complete = CompleteEvent(result="first", parent_event_id=None)
        intervention = ("INTERVENTION", "user1", "keep going")
        second_complete = CompleteEvent(result="second", parent_event_id=None)

        runner = FakeClaudeRunner(events=[first_complete, intervention, second_complete])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # complete 이벤트만 필터링
        complete_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_broadcasts) == 2

        first_parent = complete_broadcasts[0][1]["parent_event_id"]
        second_parent = complete_broadcasts[1][1]["parent_event_id"]

        # 첫 번째는 최초 user_message의 ID (1)
        assert first_parent == "1"
        # 두 번째는 intervention user_message의 ID (intervention은 2번째 저장 이벤트)
        # EventStore ID: 1=user_message, 2=first_complete, 3=intervention_user_message
        # → second_complete의 parent_event_id = "3"
        assert second_parent != first_parent
        assert second_parent is not None


class TestInterventionBroadcastEventId:
    """intervention_sent 브로드캐스트에 _event_id가 포함되는지 검증"""

    @pytest.mark.asyncio
    async def test_intervention_broadcast_includes_event_id(self):
        """intervention_sent 브로드캐스트 dict에 _event_id가 JSONL event_id로 설정된다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        # 시퀀스: intervention → complete
        intervention = ("INTERVENTION", "user1", "keep going")
        complete_event = CompleteEvent(result="done", parent_event_id=None)
        runner = FakeClaudeRunner(events=[intervention, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # intervention_sent 브로드캐스트 찾기
        intervention_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "intervention_sent"
        ]
        assert len(intervention_broadcasts) == 1
        _, intv_dict = intervention_broadcasts[0]

        # _event_id가 존재하고 정수(JSONL event_id)여야 함
        assert "_event_id" in intv_dict
        assert isinstance(intv_dict["_event_id"], int)

    @pytest.mark.asyncio
    async def test_intervention_broadcast_no_event_id_without_store(self):
        """SessionDB 없으면 intervention_sent에 _event_id가 없다"""
        task = _make_task()
        tasks = {task.agent_session_id: task}

        intervention = ("INTERVENTION", "user1", "keep going")
        complete_event = CompleteEvent(result="done", parent_event_id=None)
        runner = FakeClaudeRunner(events=[intervention, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=None)
        await executor._run_execution(task, runner, FakeResourceManager())

        intervention_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "intervention_sent"
        ]
        assert len(intervention_broadcasts) == 1
        _, intv_dict = intervention_broadcasts[0]

        # SessionDB 없으면 _event_id가 설정되지 않음
        assert "_event_id" not in intv_dict

    @pytest.mark.asyncio
    async def test_intervention_event_id_matches_jsonl(self):
        """intervention_sent의 _event_id가 JSONL에 기록된 user_message의 ID와 일치한다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        intervention = ("INTERVENTION", "user1", "intervention text here")
        complete_event = CompleteEvent(result="done", parent_event_id=None)
        runner = FakeClaudeRunner(events=[intervention, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # DB에서 intervention user_message 찾기 (user 필드로 구분)
        all_events = session_db._events.get(task.agent_session_id, [])
        intervention_msgs = [
            e for e in all_events
            if json.loads(e["payload"]).get("type") == "user_message"
            and json.loads(e["payload"]).get("user") == "user1"
        ]
        assert len(intervention_msgs) == 1
        jsonl_id = intervention_msgs[0]["id"]

        # 브로드캐스트의 _event_id와 일치해야 함
        intervention_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "intervention_sent"
        ]
        _, intv_dict = intervention_broadcasts[0]
        assert intv_dict["_event_id"] == jsonl_id


class TestExceptionPathParentEventId:
    """exception 경로에서 parent_event_id가 포함되는지 검증"""

    @pytest.mark.asyncio
    async def test_runtime_error_includes_parent_event_id(self):
        """resource acquire 실패 시 에러 dict에 parent_event_id가 None으로 포함된다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner(events=[])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManagerFailure())

        error_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "error"
        ]
        assert len(error_broadcasts) == 1
        _, error_dict = error_broadcasts[0]
        # resource acquire 실패 시 user_message가 기록되지 않으므로 parent_event_id=None
        assert "parent_event_id" in error_dict
        assert error_dict["parent_event_id"] is None

    @pytest.mark.asyncio
    async def test_exception_includes_parent_event_id(self):
        """claude_runner.execute() 예외 시 에러 dict에 parent_event_id가 포함된다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunnerException()

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        error_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "error"
        ]
        assert len(error_broadcasts) == 1
        _, error_dict = error_broadcasts[0]
        assert "parent_event_id" in error_dict
        # user_message가 기록된 후 예외가 발생하므로 parent_event_id = "1"
        assert error_dict["parent_event_id"] == "1"


class TestJSONLPersistence:
    """JSONL에 parent_event_id가 올바르게 저장되는지 검증"""

    @pytest.mark.asyncio
    async def test_parent_event_id_persisted_in_jsonl(self):
        """JSONL 파일의 이벤트에 parent_event_id가 올바르게 기록된다"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        complete_event = CompleteEvent(
            result="persisted",
            claude_session_id="claude-p",
            parent_event_id=None,
        )
        runner = FakeClaudeRunner(events=[complete_event])

        executor, _ = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # DB에서 이벤트 읽기
        all_events = session_db._events.get(task.agent_session_id, [])
        assert len(all_events) >= 2  # user_message + complete

        # user_message
        user_msg = json.loads(all_events[0]["payload"])
        assert user_msg["type"] == "user_message"

        # complete
        complete_record = [
            e for e in all_events if json.loads(e["payload"]).get("type") == "complete"
        ]
        assert len(complete_record) == 1
        complete_ev = json.loads(complete_record[0]["payload"])
        assert complete_ev["parent_event_id"] == str(all_events[0]["id"])


class TestWithoutSessionDB:
    """SessionDB 없이 동작하는 경우 (current_user_request_id=None)"""

    @pytest.mark.asyncio
    async def test_parent_event_id_none_without_session_db(self):
        """SessionDB 없이도 parent_event_id=None으로 정상 동작"""
        task = _make_task()
        tasks = {task.agent_session_id: task}

        complete_event = CompleteEvent(
            result="no store",
            parent_event_id=None,
        )
        runner = FakeClaudeRunner(events=[complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=None)
        await executor._run_execution(task, runner, FakeResourceManager())

        complete_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "complete"
        ]
        assert len(complete_broadcasts) == 1
        _, complete_dict = complete_broadcasts[0]
        # SessionDB 없으면 current_user_request_id=None → parent_event_id=None 유지
        assert complete_dict["parent_event_id"] is None


class TestGranularEventParentEventId:
    """세분화 이벤트(thinking, text_start, tool_start)의 parent_event_id 처리 검증

    카드 규칙 3: parent_tool_use_id 없음 → user_request의 자식 (서버)
    이 규칙은 complete/error뿐 아니라 모든 parent_event_id 보유 이벤트에 동일하게 적용된다.
    """

    @pytest.mark.asyncio
    async def test_top_level_thinking_gets_user_request_id(self):
        """최상위 thinking 이벤트(parent_event_id=None)가 user_request_id로 채워진다"""
        import time
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        thinking_event = ThinkingSSEEvent(
            thinking="deep thought",
            signature="sig-1",
            timestamp=time.time(),
            parent_event_id=None,  # 최상위 → user_request의 자식이 되어야 함
        )
        complete_event = CompleteEvent(result="done", parent_event_id=None)
        runner = FakeClaudeRunner(events=[thinking_event, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        thinking_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "thinking"
        ]
        assert len(thinking_broadcasts) == 1
        _, thinking_dict = thinking_broadcasts[0]
        assert thinking_dict["parent_event_id"] == "1"  # user_message의 event_id

    @pytest.mark.asyncio
    async def test_subagent_thinking_preserves_parent(self):
        """서브에이전트 thinking(parent_event_id=toolu_*)은 변경되지 않는다"""
        import time
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        thinking_event = ThinkingSSEEvent(
            thinking="subagent thought",
            signature="sig-2",
            timestamp=time.time(),
            parent_event_id="toolu_AAA",  # SDK가 설정한 값 보존
        )
        complete_event = CompleteEvent(result="done", parent_event_id=None)
        runner = FakeClaudeRunner(events=[thinking_event, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        thinking_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "thinking"
        ]
        assert len(thinking_broadcasts) == 1
        _, thinking_dict = thinking_broadcasts[0]
        assert thinking_dict["parent_event_id"] == "toolu_AAA"

    @pytest.mark.asyncio
    async def test_tool_start_gets_user_request_id(self):
        """최상위 tool_start(parent_event_id=None)가 user_request_id로 채워진다"""
        import time
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        tool_event = ToolStartSSEEvent(
            tool_name="Bash",
            tool_input={"command": "ls"},
            timestamp=time.time(),
            parent_event_id=None,
        )
        complete_event = CompleteEvent(result="done", parent_event_id=None)
        runner = FakeClaudeRunner(events=[tool_event, complete_event])

        executor, broadcasts = _make_executor(tasks, session_db=session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        tool_broadcasts = [
            (sid, ev) for sid, ev in broadcasts
            if isinstance(ev, dict) and ev.get("type") == "tool_start"
        ]
        assert len(tool_broadcasts) == 1
        _, tool_dict = tool_broadcasts[0]
        assert tool_dict["parent_event_id"] == "1"
