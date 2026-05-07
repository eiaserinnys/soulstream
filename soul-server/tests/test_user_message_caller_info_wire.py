"""user_message 이벤트 wire에 caller_info nested 키 영속화·broadcast 단언 회귀 테스트.

직전 결함 (260507.10.caller-info-propagation-fix 카드):
DB events 행에 caller_info 최상위 키 자체가 누락되어 catalog/sessionList userPortraitUrl=null,
unified-dashboard 채팅에서 user 메시지 아바타 미표시. 결함 4(테스트 게이트 부재)의 직접 차단.

검증:
- task.caller_info가 v1 agent dict → user_message payload에 caller_info nested 키 존재 + 값 동일
- task.caller_info가 v1 browser dict → 동일
- task.caller_info가 None → user_message payload에 caller_info 키 부재 (가드 silent skip — 정상 동작)
- task.caller_info가 빈 dict {} → caller_info 키 부재 (truthy 가드 의미 보존)

영속화 단언과 broadcast 단언을 *둘 다* 한다 — 영속만 되고 broadcast 안 되거나 그 반대 결함도 차단.
패턴: test_attachment_payload_persist.py(L131-205)의 user_message attachments 회귀 테스트 차용.
"""

import json
from contextlib import asynccontextmanager
from typing import Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from soul_server.models.schemas import CompleteEvent
from soul_server.service.postgres_session_db import PostgresSessionDB
from soul_server.service.task_executor import TaskExecutor
from soul_server.service.task_models import Task, TaskStatus


# === Helpers (test_attachment_payload_persist.py와 동일 — 정본 보존) ===


class FakeResourceManager:
    @asynccontextmanager
    async def acquire(self, timeout: float = 5.0):
        yield


class FakeClaudeRunner:
    workspace_dir = "/fake/workspace"

    def __init__(self, events):
        self._events = events

    async def execute(self, **kwargs):
        for event in self._events:
            yield event


def _make_task(
    session_id: str = "sess-test",
    prompt: str = "hello",
    caller_info: Optional[dict] = None,
) -> Task:
    task = Task(
        agent_session_id=session_id,
        prompt=prompt,
        client_id="test-user",
        status=TaskStatus.RUNNING,
    )
    task.caller_info = caller_info
    return task


def _make_mock_session_db():
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


def _make_executor(tasks: dict, session_db: AsyncMock) -> tuple[TaskExecutor, list]:
    listener_manager = MagicMock()
    broadcast_calls: list = []

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


def _user_message_payload(events: list) -> dict:
    """events에서 첫 user_message의 payload(JSON parse)를 반환."""
    user_msg_events = [e for e in events if e["event_type"] == "user_message"]
    assert user_msg_events, "user_message event not found in DB"
    return json.loads(user_msg_events[0]["payload"])


def _user_message_broadcast(broadcast_calls: list) -> dict:
    """broadcast_calls에서 첫 user_message 이벤트 dict를 반환."""
    user_msg_broadcasts = [
        ev for _, ev in broadcast_calls if ev.get("type") == "user_message"
    ]
    assert user_msg_broadcasts, "user_message event not broadcast"
    return user_msg_broadcasts[0]


# === Tests ===


class TestUserMessageCallerInfoWire:
    """user_message 이벤트 wire에 caller_info nested 키 회귀 보호.

    송신 측(task_executor._persist_initial_messages)이 task.caller_info를
    *영속화 + broadcast* 양쪽에 누락 없이 첨부하는지 단언한다.
    """

    @pytest.mark.asyncio
    async def test_v1_agent_caller_info_persisted_and_broadcast(self):
        """위임 세션(v1 agent dict) → user_message payload·broadcast 양쪽에 caller_info nested."""
        session_db = _make_mock_session_db()
        ci = {
            "source": "agent",
            "agent_node": "eias-shopping",
            "agent_id": "seosoyoung",
            "agent_name": "서소영",
            "display_name": "서소영",
            "user_id": "seosoyoung",
            "avatar_url": "/api/nodes/eias-shopping/agents/seosoyoung/portrait",
        }
        task = _make_task(caller_info=ci)
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner([CompleteEvent(result="done", claude_session_id="c1")])
        executor, broadcast_calls = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        # 영속화 단언
        events = session_db._events.get(task.agent_session_id, [])
        payload = _user_message_payload(events)
        assert "caller_info" in payload, "DB payload에 caller_info 키 누락"
        assert payload["caller_info"] == ci

        # broadcast 단언
        bc_event = _user_message_broadcast(broadcast_calls)
        assert "caller_info" in bc_event, "broadcast wire에 caller_info 키 누락"
        assert bc_event["caller_info"] == ci

    @pytest.mark.asyncio
    async def test_v1_browser_caller_info_persisted_and_broadcast(self):
        """브라우저 세션(v1 browser dict + JWT) → user_message에 caller_info nested."""
        session_db = _make_mock_session_db()
        ci = {
            "source": "browser",
            "ip": "127.0.0.1",
            "user_agent": "Mozilla/5.0",
            "referer": None,
            "forwarded_for": None,
            "display_name": "Jubok Kim",
            "user_id": "jubok@example.com",
            "avatar_url": "https://lh3.googleusercontent.com/a/PIC",
            "email": "jubok@example.com",
        }
        task = _make_task(caller_info=ci)
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner([CompleteEvent(result="done", claude_session_id="c1")])
        executor, broadcast_calls = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        events = session_db._events.get(task.agent_session_id, [])
        payload = _user_message_payload(events)
        assert "caller_info" in payload
        assert payload["caller_info"] == ci

        bc_event = _user_message_broadcast(broadcast_calls)
        assert "caller_info" in bc_event
        assert bc_event["caller_info"] == ci

    @pytest.mark.asyncio
    async def test_none_caller_info_omits_key(self):
        """root 트리거(caller_info=None) → user_message payload·broadcast에 caller_info 키 부재.

        가드 `if task.caller_info:`의 silent skip 의미를 보존 (위임이 아닌 root 호출 표현).
        """
        session_db = _make_mock_session_db()
        task = _make_task(caller_info=None)
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner([CompleteEvent(result="done", claude_session_id="c1")])
        executor, broadcast_calls = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        events = session_db._events.get(task.agent_session_id, [])
        payload = _user_message_payload(events)
        assert "caller_info" not in payload, "None caller_info에 키가 박힘"

        bc_event = _user_message_broadcast(broadcast_calls)
        assert "caller_info" not in bc_event

    @pytest.mark.asyncio
    async def test_empty_dict_caller_info_omits_key(self):
        """빈 dict caller_info → 가드 falsy 통과 의미 보존 (키 부재)."""
        session_db = _make_mock_session_db()
        task = _make_task(caller_info={})
        tasks = {task.agent_session_id: task}

        runner = FakeClaudeRunner([CompleteEvent(result="done", claude_session_id="c1")])
        executor, broadcast_calls = _make_executor(tasks, session_db)
        await executor._run_execution(task, runner, FakeResourceManager())

        events = session_db._events.get(task.agent_session_id, [])
        payload = _user_message_payload(events)
        assert "caller_info" not in payload, "빈 dict에 caller_info 키가 박힘 (truthy 가드 의미 깨짐)"

        bc_event = _user_message_broadcast(broadcast_calls)
        assert "caller_info" not in bc_event
