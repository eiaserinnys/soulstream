"""
Session History API Tests - GET /sessions/{id}/history

대시보드용 세션 히스토리 + 라이브 스트리밍 SSE 엔드포인트 테스트.

기존 /events/{id}/stream과의 차이점:
- 저장된 이벤트 먼저 전송 후 history_sync 이벤트 발행
- complete/error 후에도 연결 유지 (resume 대비)
"""

import asyncio
import json
import pytest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


# === Fixtures ===

@pytest.fixture
def temp_event_store_dir():
    """임시 이벤트 저장소 디렉토리"""
    with TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def event_store(temp_event_store_dir):
    """EventStore 인스턴스"""
    from soul_server.service.event_store import EventStore
    return EventStore(temp_event_store_dir)


@pytest.fixture
def mock_task_manager_with_event_store(event_store):
    """EventStore가 연결된 TaskManager mock"""
    from soul_server.service.task_models import Task, TaskStatus

    manager = MagicMock()
    # event_store 프로퍼티 설정 (public interface 사용)
    manager.event_store = event_store

    # 테스트용 세션 데이터
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

    manager._tasks = {
        "sess-001": task1,
        "sess-002": task2,
    }

    # get_all_sessions 메서드 mock
    manager.get_all_sessions = MagicMock(return_value=([task1, task2], 2))

    # get_task 메서드 mock - async 함수
    async def mock_get_task(agent_session_id: str):
        return manager._tasks.get(agent_session_id)
    manager.get_task = AsyncMock(side_effect=mock_get_task)

    # add_listener / remove_listener mock
    manager.add_listener = AsyncMock()
    manager.remove_listener = AsyncMock()

    return manager


@pytest.fixture
def mock_session_broadcaster():
    """SessionBroadcaster mock"""
    broadcaster = MagicMock()
    broadcaster.add_listener = AsyncMock()
    broadcaster.remove_listener = AsyncMock()
    return broadcaster


@pytest.fixture
def test_app_with_history(mock_task_manager_with_event_store, mock_session_broadcaster):
    """history 엔드포인트가 포함된 테스트 앱

    패치는 fixture 수명 내내 활성화됩니다.
    """
    from soul_server.api.sessions import create_sessions_router

    app = FastAPI()
    with (
        patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
        patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
    ):
        router = create_sessions_router()
        app.include_router(router)
        yield app


# === GET /sessions/{id}/history 엔드포인트 등록 테스트 ===

class TestHistoryEndpointRegistration:
    """히스토리 엔드포인트 등록 테스트"""

    def test_history_endpoint_registered(self, test_app_with_history):
        """히스토리 엔드포인트가 등록되어 있어야 한다"""
        routes = [r.path for r in test_app_with_history.routes]
        assert "/sessions/{agent_session_id}/history" in routes

    def test_history_route_is_get_method(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """히스토리 엔드포인트가 GET 메서드여야 한다"""
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

        history_routes = [
            r for r in router.routes
            if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
        ]
        assert len(history_routes) == 1

        route = history_routes[0]
        assert 'GET' in route.methods


# === 저장된 이벤트 전송 테스트 ===

class TestHistoryStoredEvents:
    """저장된 이벤트 전송 테스트"""

    @pytest.mark.asyncio
    async def test_sends_stored_events_first(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """저장된 이벤트를 먼저 전송해야 한다"""
        from soul_server.api.sessions import create_sessions_router
        from sse_starlette.sse import EventSourceResponse

        event_store = mock_task_manager_with_event_store.event_store

        # 미리 이벤트 저장
        event_store.append("sess-001", {"type": "text_start", "text": "Hello"})
        event_store.append("sess-001", {"type": "text_delta", "delta": " world"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            # history 엔드포인트 찾기
            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            endpoint = history_route.endpoint

            # 엔드포인트 호출
            response = await endpoint(agent_session_id="sess-001")
            assert isinstance(response, EventSourceResponse)

            gen = response.body_iterator
            events = []

            # 저장된 이벤트 2개 + history_sync 이벤트 수신
            for _ in range(3):
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        # 첫 번째 이벤트: text_start
        assert events[0]["event"] == "text_start"
        assert events[0]["id"] == "1"

        # 두 번째 이벤트: text_delta
        assert events[1]["event"] == "text_delta"
        assert events[1]["id"] == "2"

        # 세 번째 이벤트: history_sync
        assert events[2]["event"] == "history_sync"
        data = json.loads(events[2]["data"])
        assert data["type"] == "history_sync"
        assert data["last_event_id"] == 2
        assert data["is_live"] is True  # running 세션

    @pytest.mark.asyncio
    async def test_respects_last_event_id_header(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """Last-Event-ID 헤더를 존중해야 한다"""
        from soul_server.api.sessions import create_sessions_router
        from sse_starlette.sse import EventSourceResponse

        event_store = mock_task_manager_with_event_store.event_store

        # 5개 이벤트 저장
        for i in range(5):
            event_store.append("sess-001", {"type": "text_delta", "delta": f"chunk{i}"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            endpoint = history_route.endpoint

            # Last-Event-ID=3 으로 호출 (ID 4, 5만 전송되어야 함)
            response = await endpoint(agent_session_id="sess-001", last_event_id="3")
            gen = response.body_iterator

            events = []
            for _ in range(3):  # 2개 이벤트 + history_sync
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        # ID 4, 5만 전송
        assert len(events) == 3
        assert events[0]["id"] == "4"
        assert events[1]["id"] == "5"
        assert events[2]["event"] == "history_sync"


# === history_sync 이벤트 테스트 ===

class TestHistorySyncEvent:
    """history_sync 이벤트 테스트"""

    @pytest.mark.asyncio
    async def test_history_sync_for_running_session(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """running 세션은 is_live=true여야 한다"""
        from soul_server.api.sessions import create_sessions_router

        event_store = mock_task_manager_with_event_store.event_store
        event_store.append("sess-001", {"type": "text_start"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            events = []
            for _ in range(2):  # text_start + history_sync
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        history_sync = events[-1]
        data = json.loads(history_sync["data"])
        assert data["is_live"] is True

    @pytest.mark.asyncio
    async def test_history_sync_for_completed_session(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """completed 세션은 is_live=false여야 한다"""
        from soul_server.api.sessions import create_sessions_router

        event_store = mock_task_manager_with_event_store.event_store
        event_store.append("sess-002", {"type": "complete", "result": "Done"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-002")
            gen = response.body_iterator

            events = []
            for _ in range(2):  # complete + history_sync
                try:
                    event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                    events.append(event)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break

            await gen.aclose()

        history_sync = events[-1]
        data = json.loads(history_sync["data"])
        assert data["is_live"] is False

    @pytest.mark.asyncio
    async def test_history_sync_with_no_events(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """저장된 이벤트가 없어도 history_sync가 전송되어야 한다"""
        from soul_server.api.sessions import create_sessions_router

        # 이벤트 없이 테스트

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            # 첫 번째 이벤트가 history_sync여야 함
            event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            await gen.aclose()

        assert event["event"] == "history_sync"
        data = json.loads(event["data"])
        assert data["last_event_id"] == 0
        assert data["is_live"] is True


# === 라이브 스트리밍 테스트 ===

class TestHistoryLiveStreaming:
    """라이브 스트리밍 테스트"""

    @pytest.mark.asyncio
    async def test_receives_live_events_after_history(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """히스토리 이후 라이브 이벤트를 수신해야 한다"""
        from soul_server.api.sessions import create_sessions_router
        from soul_server.service.task_models import TaskStatus

        event_store = mock_task_manager_with_event_store.event_store
        event_store.append("sess-001", {"type": "text_start"})

        # add_listener가 호출될 때 이벤트를 푸시하도록 설정
        live_queue = None

        async def capture_queue(agent_session_id, queue):
            nonlocal live_queue
            live_queue = queue

        mock_task_manager_with_event_store.add_listener = AsyncMock(side_effect=capture_queue)

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            # 저장된 이벤트 + history_sync 수신
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # text_start
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # history_sync

            # 라이브 이벤트 푸시 (백그라운드)
            async def push_live_event():
                await asyncio.sleep(0.01)
                if live_queue:
                    await live_queue.put({
                        "type": "text_delta",
                        "delta": "live content",
                        "_event_id": 2,
                    })

            push_task = asyncio.create_task(push_live_event())

            # 라이브 이벤트 수신
            try:
                live_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                assert live_event["event"] == "text_delta"
                # 라이브 이벤트에 SSE id: 필드가 포함되어야 한다
                assert live_event["id"] == "2"
                # data JSON에는 _event_id가 포함되지 않아야 한다
                data = json.loads(live_event["data"])
                assert "_event_id" not in data
            finally:
                push_task.cancel()
                await gen.aclose()

    @pytest.mark.asyncio
    async def test_live_event_without_event_id_has_no_sse_id(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """_event_id가 없는 라이브 이벤트(history_sync, keepalive)에는 SSE id가 없어야 한다"""
        from soul_server.api.sessions import create_sessions_router

        event_store = mock_task_manager_with_event_store.event_store
        event_store.append("sess-001", {"type": "text_start"})

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            # text_start (stored, has id)
            stored_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert "id" in stored_event

            # history_sync (no _event_id, should not have SSE id)
            sync_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert sync_event["event"] == "history_sync"
            assert "id" not in sync_event

            await gen.aclose()


# === 연결 유지 테스트 (complete/error 후) ===

class TestHistoryConnectionPersistence:
    """complete/error 후 연결 유지 테스트"""

    @pytest.mark.asyncio
    async def test_connection_stays_open_after_complete(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """complete 이벤트 후에도 연결이 유지되어야 한다"""
        from soul_server.api.sessions import create_sessions_router

        event_store = mock_task_manager_with_event_store.event_store
        event_store.append("sess-001", {"type": "text_start"})
        event_store.append("sess-001", {"type": "complete", "result": "Done"})

        live_queue = None

        async def capture_queue(agent_session_id, queue):
            nonlocal live_queue
            live_queue = queue

        mock_task_manager_with_event_store.add_listener = AsyncMock(side_effect=capture_queue)

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

            history_route = next(
                r for r in router.routes
                if getattr(r, 'path', '') == '/sessions/{agent_session_id}/history'
            )
            response = await history_route.endpoint(agent_session_id="sess-001")
            gen = response.body_iterator

            # 저장된 이벤트 모두 수신
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # text_start
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # complete
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)  # history_sync

            # complete 후에도 새 이벤트(resume)를 수신할 수 있어야 함
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
                # 연결이 열려있어야 새 이벤트 수신 가능
                resume_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
                assert resume_event["event"] == "text_start"
            finally:
                push_task.cancel()
                await gen.aclose()


# === 404 오류 테스트 ===

class TestHistoryNotFound:
    """존재하지 않는 세션 테스트"""

    @pytest.mark.asyncio
    async def test_returns_404_for_nonexistent_session(
        self, mock_task_manager_with_event_store, mock_session_broadcaster
    ):
        """존재하지 않는 세션에 대해 404를 반환해야 한다"""
        from fastapi import HTTPException
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager_with_event_store),
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
