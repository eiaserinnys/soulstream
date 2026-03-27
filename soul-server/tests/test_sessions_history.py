"""
Session History API Tests - GET /sessions/{id}/history

대시보드용 세션 히스토리 + 라이브 스트리밍 SSE 엔드포인트 테스트.

PostgresSessionDB.read_events() mock을 사용하여 저장 이벤트를 시뮬레이션한다.
"""

import asyncio
import json
import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI


def _make_mock_db():
    """PostgresSessionDB mock"""
    db = MagicMock()
    db._events = {}  # session_id -> list of event dicts

    async def mock_read_events(session_id, after_id=0, limit=None):
        events = db._events.get(session_id, [])
        return [e for e in events if e["id"] > after_id]

    db.read_events = AsyncMock(side_effect=mock_read_events)

    async def mock_stream_events_raw(session_id, after_id=0):
        events = db._events.get(session_id, [])
        for ev in events:
            if ev["id"] > after_id:
                yield ev["id"], ev["event_type"], ev["payload"]

    db.stream_events_raw = mock_stream_events_raw
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
    """TaskManager mock"""
    from soul_server.service.task_models import Task, TaskStatus

    manager = MagicMock()

    task1 = Task(
        agent_session_id="sess-001",
        prompt="Hello world",
        status=TaskStatus.RUNNING,
        client_id="test-client",
        created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
    )
    task2 = Task(
        agent_session_id="sess-002",
        prompt="Completed task",
        status=TaskStatus.COMPLETED,
        client_id="test-client",
        result="Done",
        created_at=datetime(2026, 3, 3, 1, 0, 0, tzinfo=timezone.utc),
        completed_at=datetime(2026, 3, 3, 1, 30, 0, tzinfo=timezone.utc),
    )

    manager._tasks = {"sess-001": task1, "sess-002": task2}

    async def mock_get_task(agent_session_id: str):
        return manager._tasks.get(agent_session_id)
    manager.get_task = AsyncMock(side_effect=mock_get_task)
    manager.add_listener = AsyncMock()
    manager.remove_listener = AsyncMock()

    return manager


@pytest.fixture
def mock_session_broadcaster():
    broadcaster = MagicMock()
    broadcaster.add_client = MagicMock(return_value=asyncio.Queue())
    broadcaster.remove_client = MagicMock()
    return broadcaster


@pytest.fixture
def test_app_with_history(mock_task_manager, mock_session_broadcaster, mock_db):
    from soul_server.api.sessions import create_sessions_router

    app = FastAPI()
    with (
        patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
        patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
    ):
        router = create_sessions_router()
        app.include_router(router)
        yield app


# === GET /sessions/{id}/history 엔드포인트 등록 테스트 ===

class TestHistoryEndpointRegistration:
    def test_history_endpoint_registered(self, test_app_with_history):
        routes = [r.path for r in test_app_with_history.routes]
        assert "/sessions/{agent_session_id}/history" in routes

    def test_history_route_is_get_method(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

        history_routes = [
            r for r in router.routes
            if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
        ]
        assert len(history_routes) == 1
        assert 'GET' in history_routes[0].methods


# === 저장된 이벤트 전송 테스트 ===

class TestHistoryStoredEvents:
    @pytest.mark.asyncio
    async def test_sends_stored_events_first(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        _append_event(mock_db, "sess-001", {"type": "text_start", "text": "Hello"})
        _append_event(mock_db, "sess-001", {"type": "text_delta", "delta": " world"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            events = []
            for _ in range(3):
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        assert events[0]["event"] == "text_start"
        assert events[0]["id"] == "1"
        assert events[1]["event"] == "text_delta"
        assert events[1]["id"] == "2"
        assert events[2]["event"] == "history_sync"

    @pytest.mark.asyncio
    async def test_respects_last_event_id_header(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        for i in range(5):
            _append_event(mock_db, "sess-001", {"type": "text_delta", "delta": f"chunk{i}"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),
        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001", last_event_id="3")
            gen = response.body_iterator

            events = []
            for _ in range(3):
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        assert len(events) == 3
        assert events[0]["id"] == "4"
        assert events[1]["id"] == "5"
        assert events[2]["event"] == "history_sync"


# === history_sync 이벤트 테스트 ===

class TestHistorySyncEvent:
    @pytest.mark.asyncio
    async def test_history_sync_for_running_session(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        _append_event(mock_db, "sess-001", {"type": "text_start"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),

        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            events = []
            for _ in range(2):
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        data = json.loads(events[-1]["data"])
        assert data["is_live"] is True

    @pytest.mark.asyncio
    async def test_history_sync_for_completed_session(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        _append_event(mock_db, "sess-002", {"type": "complete", "result": "Done"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),

        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-002")
            gen = response.body_iterator

            events = []
            for _ in range(2):
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        data = json.loads(events[-1]["data"])
        assert data["is_live"] is False

    @pytest.mark.asyncio
    async def test_history_sync_with_no_events(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),

        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            await gen.aclose()

        assert event["event"] == "history_sync"
        data = json.loads(event["data"])
        assert data["last_event_id"] == 0
        assert data["is_live"] is True


# === 라이브 스트리밍 테스트 ===

class TestHistoryLiveStreaming:
    @pytest.mark.asyncio
    async def test_receives_live_events_after_history(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        _append_event(mock_db, "sess-001", {"type": "text_start"})

        live_queue = None

        async def capture_queue(agent_session_id, queue):
            nonlocal live_queue
            live_queue = queue

        mock_task_manager.add_listener = AsyncMock(side_effect=capture_queue)

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),

        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # text_start
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # history_sync

            async def push_live_event():
                await asyncio.sleep(0.01)
                if live_queue:
                    await live_queue.put({
                        "type": "text_delta",
                        "delta": "live content",
                        "_event_id": 2,
                    })

            push_task = asyncio.create_task(push_live_event())

            try:
                live_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                assert live_event["event"] == "text_delta"
                assert live_event["id"] == "2"
                data = json.loads(live_event["data"])
                assert "_event_id" not in data
            finally:
                push_task.cancel()
                await gen.aclose()

    @pytest.mark.asyncio
    async def test_live_event_without_event_id_has_no_sse_id(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        _append_event(mock_db, "sess-001", {"type": "text_start"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),

        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            stored_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert "id" in stored_event

            sync_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert sync_event["event"] == "history_sync"
            assert "id" not in sync_event

            await gen.aclose()


# === 연결 유지 테스트 ===

class TestHistoryConnectionPersistence:
    @pytest.mark.asyncio
    async def test_connection_stays_open_after_complete(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from soul_server.api.sessions import create_sessions_router

        _append_event(mock_db, "sess-001", {"type": "text_start"})
        _append_event(mock_db, "sess-001", {"type": "complete", "result": "Done"})

        live_queue = None

        async def capture_queue(agent_session_id, queue):
            nonlocal live_queue
            live_queue = queue

        mock_task_manager.add_listener = AsyncMock(side_effect=capture_queue)

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
            patch("soul_server.service.postgres_session_db.get_session_db", return_value=mock_db),

        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # text_start
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # complete
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # history_sync

            async def push_resume_event():
                await asyncio.sleep(0.01)
                if live_queue:
                    await live_queue.put({
                        "type": "text_start",
                        "text": "Resumed!",
                        "_event_id": 3,
                    })

            push_task = asyncio.create_task(push_resume_event())

            try:
                resume_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                assert resume_event["event"] == "text_start"
            finally:
                push_task.cancel()
                await gen.aclose()


# === 404 오류 테스트 ===

class TestHistoryNotFound:
    @pytest.mark.asyncio
    async def test_returns_404_for_nonexistent_session(self, mock_task_manager, mock_session_broadcaster, mock_db):
        from fastapi import HTTPException
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )

            with pytest.raises(HTTPException) as exc_info:
                await history_route.endpoint(agent_session_id="nonexistent-session")

        assert exc_info.value.status_code == 404
        assert "SESSION_NOT_FOUND" in str(exc_info.value.detail)
