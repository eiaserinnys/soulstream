"""
API Session Events Tests - GET /api/sessions/{id}/events

대시보드 채팅 창 SSE 엔드포인트 테스트.
EventSourceResponse 사용 확인, LLM 세션 조기 종료, lastEventId 쿼리 파라미터 지원.
"""

import asyncio
import json
import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from sse_starlette.sse import EventSourceResponse

from soul_server.service.task_models import Task, TaskStatus


def _make_mock_db():
    """PostgresSessionDB mock"""
    db = MagicMock()
    db._events = {}

    async def mock_stream_events_raw(session_id, after_id=0):
        events = db._events.get(session_id, [])
        for ev in events:
            if ev["id"] > after_id:
                yield ev["id"], ev["event_type"], ev["payload"]

    db.stream_events_raw = mock_stream_events_raw

    async def mock_read_last_event_id(session_id):
        events = db._events.get(session_id, [])
        return max((e["id"] for e in events), default=0)

    db.read_last_event_id = mock_read_last_event_id

    async def mock_read_last_event_of_type(session_id, event_type):
        events = db._events.get(session_id, [])
        matches = [e for e in events if e["event_type"] == event_type]
        return matches[-1] if matches else None

    db.read_last_event_of_type = mock_read_last_event_of_type
    return db


def _append_event(db, session_id: str, event: dict, event_id: int = None):
    """mock DB에 이벤트 추가"""
    if session_id not in db._events:
        db._events[session_id] = []
    eid = event_id or (len(db._events[session_id]) + 1)
    db._events[session_id].append({
        "id": eid,
        "session_id": session_id,
        "event_type": event.get("type", "unknown"),
        "payload": json.dumps(event),
        "searchable_text": "",
        "created_at": datetime.now(timezone.utc),
    })


@pytest.fixture
def mock_db():
    return _make_mock_db()


@pytest.fixture
def mock_task_manager():
    manager = MagicMock()

    claude_task = Task(
        agent_session_id="sess-001",
        prompt="Hello world",
        status=TaskStatus.RUNNING,
        client_id="test-client",
        created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
    )
    llm_task = Task(
        agent_session_id="llm-001",
        prompt="LLM request",
        status=TaskStatus.COMPLETED,
        client_id="test-client",
        session_type="llm",
        result="Done",
        created_at=datetime(2026, 3, 3, 1, 0, 0, tzinfo=timezone.utc),
        completed_at=datetime(2026, 3, 3, 1, 30, 0, tzinfo=timezone.utc),
    )

    manager._tasks = {"sess-001": claude_task, "llm-001": llm_task}

    async def mock_get_task(agent_session_id: str):
        return manager._tasks.get(agent_session_id)

    manager.get_task = AsyncMock(side_effect=mock_get_task)
    manager.listener_manager.add_listener = AsyncMock()
    manager.listener_manager.remove_listener = AsyncMock()

    return manager


# === EventSourceResponse 사용 확인 ===

class TestEventSourceResponseUsed:
    @pytest.mark.asyncio
    async def test_returns_event_source_response(self, mock_task_manager, mock_db):
        """api_session_events가 EventSourceResponse를 반환하는지 확인"""
        with (
            patch("soul_server.dashboard.routes.sessions._query.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.dashboard.routes.sessions import api_session_events

            # Request mock
            request = MagicMock()
            request.headers = {}
            request.query_params = {}

            response = await api_session_events("sess-001", request)
            assert isinstance(response, EventSourceResponse)


# === LLM 세션 조기 종료 ===

class TestLLMSessionEarlyExit:
    @pytest.mark.asyncio
    async def test_llm_session_after_id_zero_sends_only_history_sync(self, mock_task_manager, mock_db):
        """LLM 세션 + after_id=0: 히스토리 skip → history_sync 1발 + 종료.

        과거 데이터는 클라이언트가 /messages API로 별도 로드한다.
        """
        _append_event(mock_db, "llm-001", {"type": "text_start", "text": "LLM response"})

        with (
            patch("soul_server.dashboard.routes.sessions._query.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            events = []
            async for event in session_events_sse_generator(
                "llm-001", 0, mock_task_manager, is_llm=True,
            ):
                events.append(event)

            # history_sync 1개만
            assert len(events) == 1
            assert events[0]["event"] == "history_sync"

            # history_sync 내용 확인
            sync_data = json.loads(events[0]["data"])
            assert sync_data["is_live"] is False
            assert sync_data["status"] == "completed"
            assert sync_data["last_event_id"] == 1  # DB의 최신 event_id

    @pytest.mark.asyncio
    async def test_llm_session_after_id_n_replays_then_history_sync(self, mock_task_manager, mock_db):
        """LLM 세션 + after_id>0: 그 이후 이벤트 리플레이 + history_sync + 종료."""
        _append_event(mock_db, "llm-001", {"type": "text_start", "text": "first"}, event_id=1)
        _append_event(mock_db, "llm-001", {"type": "text_end", "text": "second"}, event_id=2)

        with (
            patch("soul_server.dashboard.routes.sessions._query.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            events = []
            async for event in session_events_sse_generator(
                "llm-001", 1, mock_task_manager, is_llm=True,
            ):
                events.append(event)

            # event_id=2 + history_sync
            assert len(events) == 2
            assert events[0]["id"] == "2"
            assert events[1]["event"] == "history_sync"

    @pytest.mark.asyncio
    async def test_llm_session_remove_listener_called(self, mock_task_manager, mock_db):
        """LLM 세션 종료 시 remove_listener가 호출되어야 한다"""
        with (
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            async for _ in session_events_sse_generator(
                "llm-001", 0, mock_task_manager, is_llm=True,
            ):
                pass

            # finally 블록에서 remove_listener가 호출되었는지 확인
            mock_task_manager.listener_manager.remove_listener.assert_called_once()
            call_args = mock_task_manager.listener_manager.remove_listener.call_args
            assert call_args[0][0] == "llm-001"


# === lastEventId 쿼리 파라미터 지원 ===

class TestLastEventIdQueryParam:
    @pytest.mark.asyncio
    async def test_last_event_id_from_query_param(self, mock_task_manager, mock_db):
        """lastEventId 쿼리 파라미터가 after_id로 전달되는지 확인"""
        _append_event(mock_db, "sess-001", {"type": "text_start", "text": "First"}, event_id=1)
        _append_event(mock_db, "sess-001", {"type": "text_delta", "delta": "Second"}, event_id=2)
        _append_event(mock_db, "sess-001", {"type": "text_end", "text": "Third"}, event_id=3)

        with (
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            # after_id=2 → 이벤트 3만 전송되어야 함
            events = []
            gen = session_events_sse_generator("sess-001", 2, mock_task_manager)

            # 히스토리 이벤트만 수집 (라이브 스트림 전에 타임아웃으로 중단)
            try:
                async for event in gen:
                    if "comment" in event:
                        break  # keepalive → 라이브 구간 진입, 중단
                    if event.get("event") == "history_sync":
                        events.append(event)
                        break  # history_sync 이후는 라이브 구간
                    events.append(event)
            except asyncio.TimeoutError:
                pass

            # 이벤트 ID 3만 전송되어야 함
            history_events = [e for e in events if e.get("event") not in ("history_sync",)]
            assert len(history_events) == 1
            assert history_events[0]["id"] == "3"

    @pytest.mark.asyncio
    async def test_last_event_id_from_header(self, mock_task_manager, mock_db):
        """Last-Event-ID 헤더가 after_id로 전달되는지 확인"""
        _append_event(mock_db, "sess-001", {"type": "text_start", "text": "First"}, event_id=1)
        _append_event(mock_db, "sess-001", {"type": "text_end", "text": "Second"}, event_id=2)

        with (
            patch("soul_server.dashboard.routes.sessions._query.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.dashboard.routes.sessions import api_session_events

            request = MagicMock()
            request.headers = {"Last-Event-ID": "1"}
            request.query_params = {}

            response = await api_session_events("sess-001", request)
            assert isinstance(response, EventSourceResponse)


# === 히스토리 이벤트 전송 ===

class TestHistoryEventDelivery:
    @pytest.mark.asyncio
    async def test_after_id_n_streams_after_n(self, mock_task_manager, mock_db):
        """after_id>0 시 그 이후 이벤트가 dict 형태로 yield되는지 확인 (재연결 catch-up 경로)."""
        _append_event(mock_db, "sess-001", {"type": "text_start", "text": "Hello"}, event_id=1)
        _append_event(mock_db, "sess-001", {"type": "text_delta", "delta": " world"}, event_id=2)
        _append_event(mock_db, "sess-001", {"type": "text_end", "text": "!"}, event_id=3)

        with (
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            # after_id=1 → event_id 2, 3만 리플레이
            events = []
            gen = session_events_sse_generator("sess-001", 1, mock_task_manager)

            try:
                async for event in gen:
                    events.append(event)
                    if event.get("event") == "history_sync":
                        break
            except asyncio.TimeoutError:
                pass

            # 히스토리 2개(id=2,3) + history_sync
            history = [e for e in events if e.get("event") not in ("history_sync",)]
            assert len(history) == 2
            assert {e["id"] for e in history} == {"2", "3"}

            # dict 형태 확인 (raw SSE 문자열이 아님)
            assert isinstance(history[0], dict)
            assert "id" in history[0]
            assert "event" in history[0]
            assert "data" in history[0]


# === after_id 의미: 0=skip, >0=replay ===

class TestAfterIdSemantics:
    @pytest.mark.asyncio
    async def test_after_id_zero_skips_history_sends_history_sync(self, mock_task_manager, mock_db):
        """after_id=0 시 히스토리 이벤트를 건너뛰고 history_sync만 전송 (신규 구독 경로)."""
        _append_event(mock_db, "sess-001", {"type": "text_start", "text": "Hello"}, event_id=1)
        _append_event(mock_db, "sess-001", {"type": "text_delta", "delta": " world"}, event_id=2)

        with (
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            events = []
            gen = session_events_sse_generator("sess-001", 0, mock_task_manager)

            try:
                async for event in gen:
                    events.append(event)
                    if event.get("event") == "history_sync":
                        break
            except asyncio.TimeoutError:
                pass

            # 히스토리 이벤트 없이 history_sync만
            assert len(events) == 1
            assert events[0]["event"] == "history_sync"

            # history_sync의 last_event_id가 DB 최신 이벤트 ID(2)인지 확인
            sync_data = json.loads(events[0]["data"])
            assert sync_data["last_event_id"] == 2

    @pytest.mark.asyncio
    async def test_after_id_zero_empty_session(self, mock_task_manager, mock_db):
        """after_id=0, 빈 세션에서 history_sync의 last_event_id가 0."""
        with (
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            events = []
            gen = session_events_sse_generator("sess-new", 0, mock_task_manager)

            try:
                async for event in gen:
                    events.append(event)
                    if event.get("event") == "history_sync":
                        break
            except asyncio.TimeoutError:
                pass

            assert len(events) == 1
            sync_data = json.loads(events[0]["data"])
            assert sync_data["last_event_id"] == 0


# === 라이브 스트림 중 disconnect 시 cleanup 확인 ===

class TestMidStreamDisconnectCleanup:
    @pytest.mark.asyncio
    async def test_remove_listener_called_on_live_stream_cancel(self, mock_task_manager, mock_db):
        """라이브 스트리밍 중 generator가 close되면 remove_listener가 호출되어야 한다.

        stream_session_events를 직접 테스트하여, 라이브 이벤트를 수신하는 도중
        generator를 close했을 때 finally에서 remove_listener가 호출되는지 확인한다.
        EventSourceResponse가 ASGI disconnect 감지 시 수행하는 것과 동일한 경로.
        """
        from soul_server.api.sessions import stream_session_events

        event_queue = asyncio.Queue()
        # 라이브 이벤트를 큐에 넣어 즉시 수신 가능하게
        await event_queue.put({"type": "text_delta", "delta": "live!", "_event_id": 10})

        gen = stream_session_events("sess-001", 0, mock_task_manager, event_queue)
        aiter = gen.__aiter__()

        # history_sync 수신 (Part 2) — 이제 SSE dict 형식 yield
        event = await aiter.__anext__()
        assert event.get("event") == "history_sync"

        # 라이브 이벤트 수신 (Part 3) — stream_live_events가 wrap한 SSE dict
        event = await aiter.__anext__()
        assert event.get("event") == "text_delta"

        # 브라우저 disconnect 시뮬레이션: generator를 close
        await gen.aclose()

        # finally에서 remove_listener가 호출되었는지 확인.
        # stream_live_events.aclose() finally + stream_session_events 외부 finally
        # 양쪽이 호출 가능 — remove_listener는 idempotent라 무해.
        assert mock_task_manager.listener_manager.remove_listener.called
        call_args = mock_task_manager.listener_manager.remove_listener.call_args
        assert call_args[0][0] == "sess-001"
        assert call_args[0][1] is event_queue

    @pytest.mark.asyncio
    async def test_remove_listener_called_on_history_phase_cancel(self, mock_task_manager, mock_db):
        """히스토리 전송 중 generator가 close되면 remove_listener가 호출되어야 한다.

        과거 내역 전송 도중 브라우저가 끊기는 에지 케이스.
        entered_stream=False이므로 외부 finally에서 직접 cleanup.
        after_id>0 경로(재연결 catch-up)에서만 히스토리가 yield되므로 after_id>0으로 호출.
        """
        # 이벤트를 여러 개 추가
        for i in range(1, 6):
            _append_event(mock_db, "sess-001", {"type": "text_delta", "delta": f"chunk-{i}"}, event_id=i)

        with (
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            from soul_server.api.sessions import session_events_sse_generator

            # after_id=0은 history skip이므로 catch-up 경로(after_id>0)로 진입
            gen = session_events_sse_generator("sess-001", 1, mock_task_manager)

            # 히스토리 이벤트 하나만 받고 즉시 close (히스토리 전송 중 disconnect)
            event = await gen.__anext__()
            assert event["event"] == "text_delta"
            await gen.aclose()

            # entered_stream=False이므로 외부 finally에서 remove_listener 호출
            # (stream_session_events 외부 finally가 추가되면서 호출 횟수가 2회가 될 수 있음 — idempotent)
            assert mock_task_manager.listener_manager.remove_listener.called
            call_args = mock_task_manager.listener_manager.remove_listener.call_args
            assert call_args[0][0] == "sess-001"

    @pytest.mark.asyncio
    async def test_remove_listener_called_on_history_sync_disconnect(self, mock_task_manager, mock_db):
        """is_live=False 세션에서 history_sync 받자마자 disconnect 시에도 remove_listener 호출.

        2026-05-03 code-reviewer가 발견한 listener 누수 회귀 방지.
        stream_session_events의 is_live=False 분기 yield 직후 aclose되면 외부 finally에서 cleanup.
        """
        from soul_server.api.sessions import stream_session_events
        from soul_server.service.task_models import TaskStatus as TaskModelStatus

        # 완료된 세션 mock — is_live=False가 되도록
        completed_task = MagicMock()
        completed_task.status = TaskModelStatus.COMPLETED
        mock_task_manager.get_task = AsyncMock(return_value=completed_task)

        event_queue = asyncio.Queue()
        gen = stream_session_events("sess-001", 0, mock_task_manager, event_queue)

        # history_sync 받자마자 disconnect (라이브 진입 전)
        event = await gen.__anext__()
        assert event.get("event") == "history_sync"
        await gen.aclose()

        # 외부 finally가 호출되어야 함 (회귀 방지 핵심)
        assert mock_task_manager.listener_manager.remove_listener.called
        call_args = mock_task_manager.listener_manager.remove_listener.call_args
        assert call_args[0][0] == "sess-001"
        assert call_args[0][1] is event_queue


# === prompt_suggestion baseline 동봉 (Phase 2) ===

class TestPromptSuggestionBaseline:
    """stream_session_events: history_sync 직전에 마지막 prompt_suggestion 이벤트를 baseline으로 yield"""

    @pytest.mark.asyncio
    async def test_baseline_yielded_when_present(self, mock_task_manager, mock_db):
        """저장된 prompt_suggestion이 있으면 history_sync 직전에 baseline 이벤트가 yield된다"""
        # 완료된 세션 mock (is_live=False)
        from soul_server.service.task_models import TaskStatus as TaskModelStatus
        completed_task = MagicMock()
        completed_task.status = TaskModelStatus.COMPLETED
        mock_task_manager.get_task = AsyncMock(return_value=completed_task)

        # 저장된 prompt_suggestion 이벤트
        _append_event(
            mock_db, "sess-001",
            {"type": "prompt_suggestion", "text": "다음 단계 시도해보세요", "timestamp": 1234567890.0},
        )

        with patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db):
            from soul_server.api.sessions import stream_session_events
            event_queue = asyncio.Queue()
            events = []
            async for sse_event in stream_session_events(
                "sess-001", 0, mock_task_manager, event_queue,
            ):
                events.append(sse_event)

        # 첫 번째 이벤트가 baseline prompt_suggestion, 두 번째가 history_sync
        assert len(events) >= 2
        assert events[0].get("event") == "prompt_suggestion"
        baseline_payload = json.loads(events[0]["data"])
        assert baseline_payload["text"] == "다음 단계 시도해보세요"
        assert events[1].get("event") == "history_sync"

    @pytest.mark.asyncio
    async def test_no_baseline_when_absent(self, mock_task_manager, mock_db):
        """저장된 prompt_suggestion이 없으면 history_sync만 발행되고 baseline은 없다"""
        from soul_server.service.task_models import TaskStatus as TaskModelStatus
        completed_task = MagicMock()
        completed_task.status = TaskModelStatus.COMPLETED
        mock_task_manager.get_task = AsyncMock(return_value=completed_task)

        with patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db):
            from soul_server.api.sessions import stream_session_events
            event_queue = asyncio.Queue()
            events = []
            async for sse_event in stream_session_events(
                "sess-001", 0, mock_task_manager, event_queue,
            ):
                events.append(sse_event)

        # history_sync만 있고 prompt_suggestion baseline은 없다
        types = [e.get("event") for e in events]
        assert "history_sync" in types
        assert "prompt_suggestion" not in types

    @pytest.mark.asyncio
    async def test_is_llm_skips_baseline_lookup(self, mock_task_manager, mock_db):
        """is_llm=True면 prompt_suggestion baseline 조회를 skip한다 (SDK 경로 아님)"""
        from soul_server.service.task_models import TaskStatus as TaskModelStatus
        completed_task = MagicMock()
        completed_task.status = TaskModelStatus.COMPLETED
        mock_task_manager.get_task = AsyncMock(return_value=completed_task)

        # llm-001에 prompt_suggestion이 저장되어 있어도 yield되면 안 됨
        _append_event(
            mock_db, "llm-001",
            {"type": "prompt_suggestion", "text": "should not appear", "timestamp": 1.0},
        )

        with patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db):
            from soul_server.api.sessions import stream_session_events
            event_queue = asyncio.Queue()
            events = []
            async for sse_event in stream_session_events(
                "llm-001", 0, mock_task_manager, event_queue, is_llm=True,
            ):
                events.append(sse_event)

        types = [e.get("event") for e in events]
        assert "prompt_suggestion" not in types
