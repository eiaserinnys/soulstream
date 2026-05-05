"""attachment_paths DB payload 영속화 회귀 테스트

검증 항목:
1. user_message 이벤트에 task.attachment_paths가 payload["attachments"]로 기록된다
2. intervention_sent 이벤트에 attachment_paths가 payload["attachments"]로 기록된다
3. 자동 재개(auto-resume) 경로에서 attachment_paths가 create_task에 전달된다
4. attachment_paths가 빈 배열이면 payload에 attachments 키가 생략된다
5. attachment_paths가 None이면 payload에 attachments 키가 없다
"""

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from soul_server.models.schemas import CompleteEvent
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


# === Helpers ===


class FakeResourceManager:
    @asynccontextmanager
    async def acquire(self, timeout: float = 5.0):
        yield


class FakeClaudeRunner:
    """미리 정의된 이벤트를 yield하는 테스트용 runner"""

    workspace_dir = "/fake/workspace"

    def __init__(self, events):
        self._events = events

    async def execute(self, **kwargs):
        on_intervention_sent = kwargs.get("on_intervention_sent")
        on_runner_ready = kwargs.get("on_runner_ready")

        for event in self._events:
            if isinstance(event, tuple) and event[0] == "INTERVENTION":
                _, user, text, att_paths = event
                if on_intervention_sent:
                    await on_intervention_sent(user, text, att_paths)
                continue
            yield event


def _make_task(
    session_id: str = "sess-test",
    prompt: str = "hello",
    attachment_paths: Optional[list] = None,
) -> Task:
    task = Task(
        agent_session_id=session_id,
        prompt=prompt,
        client_id="test-user",
        status=TaskStatus.RUNNING,
    )
    task.attachment_paths = attachment_paths
    return task


def _make_mock_session_db():
    """이벤트를 인메모리로 추적하는 PostgresSessionDB mock"""
    db = AsyncMock(spec=PostgresSessionDB)
    _events = {}
    _next_ids = {}

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
    db._events = _events
    return db


def _make_executor(
    tasks: dict,
    session_db: Optional[AsyncMock] = None,
) -> tuple[TaskExecutor, list]:
    listener_manager = MagicMock()
    broadcast_calls = []

    async def capture_broadcast(session_id, event_dict):
        broadcast_calls.append((session_id, event_dict))

    listener_manager.broadcast = AsyncMock(side_effect=capture_broadcast)

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


class TestUserMessageAttachments:
    """user_message 이벤트의 attachments 필드 검증"""

    @pytest.mark.asyncio
    async def test_user_message_includes_attachments(self):
        """task.attachment_paths가 있으면 user_message payload에 attachments 포함"""
        session_db = _make_mock_session_db()
        att_paths = ["/workspace/.local/incoming/sess-test/img1.png"]
        task = _make_task(attachment_paths=att_paths)
        tasks = {task.agent_session_id: task}

        complete_event = CompleteEvent(
            result="done",
            claude_session_id="claude-1",
        )
        runner = FakeClaudeRunner([complete_event])

        executor, _ = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # user_message 이벤트가 첫 번째로 기록됨
        events = session_db._events.get(task.agent_session_id, [])
        user_msg_events = [e for e in events if e["event_type"] == "user_message"]
        assert len(user_msg_events) >= 1
        payload = json.loads(user_msg_events[0]["payload"])
        assert "attachments" in payload
        assert payload["attachments"] == att_paths

    @pytest.mark.asyncio
    async def test_user_message_omits_attachments_when_none(self):
        """task.attachment_paths가 None이면 payload에 attachments 키 없음"""
        session_db = _make_mock_session_db()
        task = _make_task(attachment_paths=None)
        tasks = {task.agent_session_id: task}

        complete_event = CompleteEvent(
            result="done",
            claude_session_id="claude-1",
        )
        runner = FakeClaudeRunner([complete_event])

        executor, _ = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        events = session_db._events.get(task.agent_session_id, [])
        user_msg_events = [e for e in events if e["event_type"] == "user_message"]
        assert len(user_msg_events) >= 1
        payload = json.loads(user_msg_events[0]["payload"])
        assert "attachments" not in payload

    @pytest.mark.asyncio
    async def test_user_message_omits_attachments_when_empty(self):
        """task.attachment_paths가 빈 배열이면 payload에 attachments 키 생략"""
        session_db = _make_mock_session_db()
        task = _make_task(attachment_paths=[])
        tasks = {task.agent_session_id: task}

        complete_event = CompleteEvent(
            result="done",
            claude_session_id="claude-1",
        )
        runner = FakeClaudeRunner([complete_event])

        executor, _ = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        events = session_db._events.get(task.agent_session_id, [])
        user_msg_events = [e for e in events if e["event_type"] == "user_message"]
        assert len(user_msg_events) >= 1
        payload = json.loads(user_msg_events[0]["payload"])
        assert "attachments" not in payload


class TestInterventionSentAttachments:
    """intervention_sent 이벤트의 attachments 필드 검증"""

    @pytest.mark.asyncio
    async def test_intervention_sent_includes_attachments(self):
        """intervention_sent 콜백에 attachment_paths 전달 시 payload에 attachments 포함"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        att_paths = ["/workspace/.local/incoming/sess-test/photo.jpg"]
        # INTERVENTION 튜플: (marker, user, text, attachment_paths)
        events = [
            ("INTERVENTION", "user1", "이 이미지 분석해줘", att_paths),
            CompleteEvent(result="done", claude_session_id="claude-1"),
        ]
        runner = FakeClaudeRunner(events)

        executor, broadcast_calls = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # DB에 기록된 intervention_sent 이벤트 확인
        all_events = session_db._events.get(task.agent_session_id, [])
        intervention_events = [e for e in all_events if e["event_type"] == "intervention_sent"]
        assert len(intervention_events) >= 1
        payload = json.loads(intervention_events[0]["payload"])
        assert "attachments" in payload
        assert payload["attachments"] == att_paths

        # SSE broadcast에도 attachments 포함
        intervention_broadcasts = [
            (sid, ev) for sid, ev in broadcast_calls
            if ev.get("type") == "intervention_sent"
        ]
        assert len(intervention_broadcasts) >= 1
        _, broadcast_event = intervention_broadcasts[0]
        assert "attachments" in broadcast_event
        assert broadcast_event["attachments"] == att_paths

    @pytest.mark.asyncio
    async def test_intervention_sent_omits_attachments_when_none(self):
        """attachment_paths가 None이면 intervention_sent에 attachments 키 없음"""
        session_db = _make_mock_session_db()
        task = _make_task()
        tasks = {task.agent_session_id: task}

        events = [
            ("INTERVENTION", "user1", "텍스트만", None),
            CompleteEvent(result="done", claude_session_id="claude-1"),
        ]
        runner = FakeClaudeRunner(events)

        executor, broadcast_calls = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        all_events = session_db._events.get(task.agent_session_id, [])
        intervention_events = [e for e in all_events if e["event_type"] == "intervention_sent"]
        assert len(intervention_events) >= 1
        payload = json.loads(intervention_events[0]["payload"])
        assert "attachments" not in payload

        intervention_broadcasts = [
            (sid, ev) for sid, ev in broadcast_calls
            if ev.get("type") == "intervention_sent"
        ]
        assert len(intervention_broadcasts) >= 1
        _, broadcast_event = intervention_broadcasts[0]
        assert "attachments" not in broadcast_event


class TestAutoResumeAttachments:
    """자동 재개(add_intervention) 경로의 attachment_paths 전달 검증"""

    @pytest.mark.asyncio
    async def test_auto_resume_passes_attachment_paths_to_create_task(self):
        """완료된 세션에 attachment_paths 포함 개입 시 create_task에 전달됨"""
        from soul_server.service.task_manager import TaskManager

        # TaskManager에 필요한 최소 mock
        listener_manager = MagicMock()
        listener_manager.broadcast = AsyncMock()
        listener_manager.broadcast_to_global = AsyncMock()

        db = AsyncMock(spec=PostgresSessionDB)
        db.update_session_status = AsyncMock()

        # 완료된 태스크를 tasks에 설정
        task = Task(
            agent_session_id="sess-completed",
            prompt="이전 작업",
            status=TaskStatus.COMPLETED,
            client_id="user1",
        )

        task_manager = TaskManager.__new__(TaskManager)
        task_manager._tasks = {"sess-completed": task}
        task_manager._db = db
        task_manager._listener_manager = listener_manager
        task_manager._eviction_manager = MagicMock()

        att_paths = ["/workspace/.local/incoming/sess-completed/img.png"]

        # create_task를 mock하여 호출 인자를 캡처
        with patch.object(task_manager, "create_task", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_task(session_id="sess-completed")

            result = await task_manager.add_intervention(
                agent_session_id="sess-completed",
                text="이 이미지 봐줘",
                user="user1",
                attachment_paths=att_paths,
            )

            assert result["auto_resumed"] is True
            # create_task 호출 시 attachment_paths 전달 검증
            mock_create.assert_called_once()
            params = mock_create.call_args.args[0]
            assert params.attachment_paths == att_paths
            # extra_context_items에 attached_files 항목 포함 검증
            extra_ctx = params.extra_context_items
            assert extra_ctx is not None
            assert len(extra_ctx) == 1
            assert extra_ctx[0]["key"] == "attached_files"
            assert "/workspace/.local/incoming/sess-completed/img.png" in extra_ctx[0]["content"]
