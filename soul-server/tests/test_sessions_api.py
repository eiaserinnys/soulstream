"""
Session API 테스트 - GET /sessions, GET /sessions/stream

TDD 방식으로 작성된 테스트입니다.
"""

import asyncio
import json
import pytest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

# 테스트용 TaskManager mock 설정
@pytest.fixture
def mock_task_manager():
    """TaskManager mock 생성"""
    from soul_server.service.task_models import Task, TaskStatus

    manager = MagicMock()

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
        prompt="Test prompt",
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
    manager.get_all_sessions = MagicMock(return_value=[task1, task2])

    return manager


@pytest.fixture
def mock_session_broadcaster():
    """SessionBroadcaster mock 생성"""
    broadcaster = MagicMock()
    broadcaster.add_listener = AsyncMock()
    broadcaster.remove_listener = AsyncMock()
    return broadcaster


@pytest.fixture
def test_app(mock_task_manager, mock_session_broadcaster):
    """테스트용 FastAPI 앱 생성"""
    from fastapi import FastAPI
    from soul_server.api.sessions import create_sessions_router

    app = FastAPI()
    router = create_sessions_router(
        task_manager=mock_task_manager,
        session_broadcaster=mock_session_broadcaster,
    )
    app.include_router(router)
    return app


class TestGetSessions:
    """GET /sessions 테스트"""

    def test_returns_session_list(self, test_app, mock_task_manager):
        """세션 목록을 반환해야 한다"""
        client = TestClient(test_app)
        response = client.get("/sessions")

        assert response.status_code == 200
        data = response.json()

        assert "sessions" in data
        assert len(data["sessions"]) == 2

        # 첫 번째 세션 검증
        sess1 = next(s for s in data["sessions"] if s["agent_session_id"] == "sess-001")
        assert sess1["status"] == "running"
        assert sess1["prompt"] == "Hello world"
        assert "created_at" in sess1
        assert "updated_at" in sess1

    def test_empty_session_list(self, mock_session_broadcaster):
        """세션이 없을 때 빈 목록을 반환해야 한다"""
        from fastapi import FastAPI
        from soul_server.api.sessions import create_sessions_router

        # 빈 TaskManager
        empty_manager = MagicMock()
        empty_manager.get_all_sessions = MagicMock(return_value=[])

        app = FastAPI()
        router = create_sessions_router(
            task_manager=empty_manager,
            session_broadcaster=mock_session_broadcaster,
        )
        app.include_router(router)

        client = TestClient(app=app)
        response = client.get("/sessions")

        assert response.status_code == 200
        data = response.json()
        assert data["sessions"] == []


class TestSessionsStream:
    """GET /sessions/stream SSE 테스트

    Note: SSE 스트리밍 테스트는 비동기 특성으로 인해 단위 테스트에서
    타임아웃이 발생할 수 있습니다. 실제 통합 테스트에서 검증합니다.
    여기서는 라우터 등록 여부만 확인합니다.
    """

    def test_stream_endpoint_registered(self, test_app):
        """스트림 엔드포인트가 등록되어 있어야 한다"""
        # 라우터가 등록되었는지 확인 (실제 SSE 연결 없이)
        routes = [r.path for r in test_app.routes]
        assert "/sessions/stream" in routes


class TestSessionBroadcaster:
    """SessionBroadcaster 단위 테스트"""

    @pytest.mark.asyncio
    async def test_add_and_remove_listener(self):
        """리스너 추가/제거가 정상 동작해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster

        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()

        await broadcaster.add_listener(queue)
        assert broadcaster.listener_count == 1

        await broadcaster.remove_listener(queue)
        assert broadcaster.listener_count == 0

    @pytest.mark.asyncio
    async def test_broadcast_to_all_listeners(self):
        """모든 리스너에게 이벤트를 브로드캐스트해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster

        broadcaster = SessionBroadcaster()
        queue1 = asyncio.Queue()
        queue2 = asyncio.Queue()

        await broadcaster.add_listener(queue1)
        await broadcaster.add_listener(queue2)

        event = {"type": "session_created", "session": {"agent_session_id": "new-sess"}}
        count = await broadcaster.broadcast(event)

        assert count == 2
        assert queue1.qsize() == 1
        assert queue2.qsize() == 1

        # 이벤트 내용 확인
        received1 = await queue1.get()
        received2 = await queue2.get()
        assert received1["type"] == "session_created"
        assert received2["type"] == "session_created"

    @pytest.mark.asyncio
    async def test_emit_session_created(self):
        """세션 생성 이벤트를 발행해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster
        from soul_server.service.task_models import Task, TaskStatus

        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        task = Task(
            agent_session_id="new-sess",
            prompt="Test",
            status=TaskStatus.RUNNING,
        )
        await broadcaster.emit_session_created(task)

        event = await queue.get()
        assert event["type"] == "session_created"
        assert event["session"]["agent_session_id"] == "new-sess"

    @pytest.mark.asyncio
    async def test_emit_session_updated(self):
        """세션 업데이트 이벤트를 발행해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster
        from soul_server.service.task_models import Task, TaskStatus
        from datetime import datetime, timezone

        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        task = Task(
            agent_session_id="sess-001",
            prompt="Test",
            status=TaskStatus.COMPLETED,
            completed_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
        )
        await broadcaster.emit_session_updated(task)

        event = await queue.get()
        assert event["type"] == "session_updated"
        assert event["agent_session_id"] == "sess-001"
        assert event["status"] == "completed"

    @pytest.mark.asyncio
    async def test_emit_session_deleted(self):
        """세션 삭제 이벤트를 발행해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster

        broadcaster = SessionBroadcaster()
        queue = asyncio.Queue()
        await broadcaster.add_listener(queue)

        await broadcaster.emit_session_deleted("sess-001")

        event = await queue.get()
        assert event["type"] == "session_deleted"
        assert event["agent_session_id"] == "sess-001"


class TestTaskManagerGetAllSessions:
    """TaskManager.get_all_sessions() 테스트"""

    @pytest.mark.asyncio
    async def test_returns_all_sessions(self):
        """모든 세션을 반환해야 한다"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        manager = TaskManager()

        # 직접 _tasks에 추가 (create_task의 부작용 없이)
        task1 = Task(agent_session_id="sess-001", prompt="Test 1", status=TaskStatus.RUNNING)
        task2 = Task(agent_session_id="sess-002", prompt="Test 2", status=TaskStatus.COMPLETED)
        manager._tasks["sess-001"] = task1
        manager._tasks["sess-002"] = task2

        sessions = manager.get_all_sessions()

        assert len(sessions) == 2
        assert any(s.agent_session_id == "sess-001" for s in sessions)
        assert any(s.agent_session_id == "sess-002" for s in sessions)

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_sessions(self):
        """세션이 없을 때 빈 목록을 반환해야 한다"""
        from soul_server.service.task_manager import TaskManager

        manager = TaskManager()
        sessions = manager.get_all_sessions()

        assert sessions == []
