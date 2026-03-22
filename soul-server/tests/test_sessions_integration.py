"""
Session Integration Tests - TC-1 ~ TC-16

실제 세션 데이터 픽스처를 사용하는 통합 테스트입니다.
EventDrivenMockRunner로 Claude Code 동작을 시뮬레이션합니다.

테스트 전략:
1. 동기 테스트: 라우터 등록, 메서드 타입, 핸들러 존재 확인
2. 비동기 테스트: event_generator를 직접 호출하여 초기 세션 목록 확인
3. 통합 테스트: 실제 SessionBroadcaster로 이벤트 수신 테스트
"""

import asyncio
import json
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient


def _make_mock_session_db():
    """TaskManager 테스트용 mock session_db 생성"""
    mock_db = MagicMock()
    mock_db.upsert_session = AsyncMock()
    mock_db.get_session = AsyncMock(return_value=None)
    mock_db.get_all_sessions = AsyncMock(return_value=([], 0))
    mock_db.delete_session = AsyncMock()
    mock_db.append_event = AsyncMock()
    mock_db.get_next_event_id = AsyncMock(return_value=1)
    mock_db.read_events = AsyncMock(return_value=[])
    mock_db.update_last_read_event_id = AsyncMock()
    mock_db.get_read_position = AsyncMock(return_value=0)
    mock_db.get_all_folders = AsyncMock(return_value=[])
    mock_db.get_folder = AsyncMock(return_value=None)
    mock_db.get_default_folder = AsyncMock(return_value=None)
    mock_db.assign_session_to_folder = AsyncMock()
    mock_db.create_folder = AsyncMock()
    mock_db.get_catalog = AsyncMock(return_value=[])
    mock_db.update_last_message = AsyncMock()
    mock_db.search_events = AsyncMock(return_value=[])
    mock_db.DEFAULT_FOLDERS = {}
    mock_db.node_id = "test-node"
    return mock_db


# === Fixtures ===

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

    # get_all_sessions → dict 리스트 반환 (카탈로그 기반 API)
    session_dicts = [
        {
            "agent_session_id": "sess-001",
            "status": "running",
            "prompt": "Hello world",
            "client_id": "test-client",
            "created_at": "2026-03-03T02:00:00+00:00",
            "updated_at": "2026-03-03T02:00:00+00:00",
            "pid": task1.pid,
            "last_message": None,
        },
        {
            "agent_session_id": "sess-002",
            "status": "completed",
            "prompt": "Test prompt",
            "client_id": "test-client",
            "created_at": "2026-03-03T01:00:00+00:00",
            "updated_at": "2026-03-03T01:30:00+00:00",
            "pid": None,
            "last_message": None,
        },
    ]
    manager.get_all_sessions = AsyncMock(return_value=(session_dicts, 2))

    return manager


@pytest.fixture
def mock_session_broadcaster():
    """SessionBroadcaster mock 생성 - 리스너 등록만 수행"""
    broadcaster = MagicMock()
    broadcaster.add_listener = AsyncMock()
    broadcaster.remove_listener = AsyncMock()
    return broadcaster


@pytest.fixture
def real_session_broadcaster():
    """실제 SessionBroadcaster 인스턴스 - 이벤트 테스트용"""
    from soul_server.service.session_broadcaster import SessionBroadcaster
    return SessionBroadcaster()


@pytest.fixture
def test_app(mock_task_manager, mock_session_broadcaster):
    """테스트용 FastAPI 앱 생성

    패치는 fixture 수명 내내 활성화됩니다.
    TestClient 요청 처리 시 핸들러 내부의 get_task_manager/get_session_broadcaster를
    mock으로 대체하기 위해 패치를 유지합니다.
    """
    from fastapi import FastAPI
    from soul_server.api.sessions import create_sessions_router

    app = FastAPI()
    with (
        patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
        patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
    ):
        router = create_sessions_router()
        app.include_router(router)
        yield app


# === GET /sessions Tests ===

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

    def test_returns_session_type_in_response(self, test_app, mock_task_manager):
        """응답에 session_type이 포함되어야 한다"""
        client = TestClient(test_app)
        response = client.get("/sessions")

        assert response.status_code == 200
        data = response.json()
        for sess in data["sessions"]:
            assert "session_type" in sess

    def test_session_type_filter(self, mock_session_broadcaster):
        """session_type 쿼리 파라미터로 필터링해야 한다"""
        from fastapi import FastAPI
        from soul_server.api.sessions import create_sessions_router
        from soul_server.service.task_models import Task, TaskStatus

        manager = MagicMock()
        # get_all_sessions은 (list[dict], int)를 반환 — Task 객체가 아닌 dict
        claude_session = {
            "agent_session_id": "sess-claude",
            "prompt": "Claude",
            "status": "running",
            "session_type": "claude",
            "created_at": "2026-03-03T02:00:00+00:00",
            "updated_at": "2026-03-03T02:00:00+00:00",
        }
        # get_all_sessions이 session_type 파라미터를 올바르게 전달받는지 확인
        manager.get_all_sessions = AsyncMock(return_value=([claude_session], 1))

        app = FastAPI()
        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()
            app.include_router(router)

            client = TestClient(app=app)
            response = client.get("/sessions?session_type=claude")

        assert response.status_code == 200
        # get_all_sessions가 session_type="claude"로 호출되었는지 확인
        call_kwargs = manager.get_all_sessions.call_args
        assert call_kwargs.kwargs.get("session_type") == "claude"

    def test_empty_session_list(self, mock_session_broadcaster):
        """세션이 없을 때 빈 목록을 반환해야 한다"""
        from fastapi import FastAPI
        from soul_server.api.sessions import create_sessions_router

        # 빈 TaskManager
        empty_manager = MagicMock()
        empty_manager.get_all_sessions = AsyncMock(return_value=([], 0))

        app = FastAPI()
        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=empty_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()
            app.include_router(router)

            client = TestClient(app=app)
            response = client.get("/sessions")

        assert response.status_code == 200
        data = response.json()
        assert data["sessions"] == []


# === GET /sessions/stream SSE Tests ===

class TestSessionsStream:
    """GET /sessions/stream SSE 테스트

    SSE 스트리밍 테스트는 HTTP 레이어를 우회하여 수행한다.
    - 동기 테스트: 라우터 등록, 메서드 타입 확인
    - 비동기 테스트: event_generator 직접 호출로 SSE 로직 검증
    """

    def test_stream_endpoint_registered(self, test_app):
        """스트림 엔드포인트가 등록되어 있어야 한다"""
        routes = [r.path for r in test_app.routes]
        assert "/sessions/stream" in routes

    def test_stream_route_is_get_method(self, mock_task_manager, mock_session_broadcaster):
        """스트림 엔드포인트가 GET 메서드여야 한다"""
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

        # /sessions/stream 라우트 찾기
        stream_routes = [r for r in router.routes if getattr(r, 'path', '') == '/sessions/stream']
        assert len(stream_routes) == 1

        # GET 메서드 확인
        route = stream_routes[0]
        assert 'GET' in route.methods

    def test_stream_endpoint_handler_exists(self, mock_task_manager, mock_session_broadcaster):
        """스트림 엔드포인트 핸들러가 존재해야 한다"""
        from soul_server.api.sessions import create_sessions_router

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=mock_session_broadcaster),
        ):
            router = create_sessions_router()

        # /sessions/stream 라우트의 endpoint 함수 확인
        stream_routes = [r for r in router.routes if getattr(r, 'path', '') == '/sessions/stream']
        route = stream_routes[0]

        # endpoint 함수가 존재하고 코루틴이어야 함
        import asyncio
        assert hasattr(route, 'endpoint')
        assert asyncio.iscoroutinefunction(route.endpoint)


class TestSessionsStreamEventGenerator:
    """SSE event_generator 직접 테스트

    HTTP 레이어를 우회하여 비동기 제너레이터를 직접 테스트한다.
    이렇게 하면 블로킹 없이 SSE 로직을 검증할 수 있다.
    """

    @pytest.mark.asyncio
    async def test_initial_session_list_sent(self, mock_task_manager, real_session_broadcaster):
        """연결 시 초기 세션 목록이 전송되어야 한다"""
        from soul_server.api.sessions import create_sessions_router
        from sse_starlette.sse import EventSourceResponse

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=real_session_broadcaster),
        ):
            router = create_sessions_router()

            # sessions_stream 엔드포인트 함수 가져오기
            stream_route = next(r for r in router.routes if getattr(r, 'path', '') == '/sessions/stream')
            endpoint = stream_route.endpoint

            # 엔드포인트 호출하여 EventSourceResponse 얻기
            response = await endpoint()
            assert isinstance(response, EventSourceResponse)

            # EventSourceResponse의 body_iterator가 event_generator
            gen = response.body_iterator

            # 첫 번째 이벤트 (초기 세션 목록) 수신
            # body_iterator는 dict 형태의 이벤트를 yield
            first_event = await gen.__anext__()

            # 이벤트 검증 - dict 형태: {"event": "...", "data": "..."}
            assert isinstance(first_event, dict)
            assert first_event["event"] == "session_list"
            assert "data" in first_event

            # JSON 데이터 파싱
            data = json.loads(first_event["data"])

            assert data["type"] == "session_list"
            assert len(data["sessions"]) == 2
            assert data["sessions"][0]["agent_session_id"] in ["sess-001", "sess-002"]

            # 제너레이터 명시적 종료 (finally 블록 실행)
            await gen.aclose()

    @pytest.mark.asyncio
    async def test_broadcast_event_received(self, mock_task_manager, real_session_broadcaster):
        """브로드캐스트된 이벤트가 스트림으로 전송되어야 한다"""
        from soul_server.api.sessions import create_sessions_router
        from sse_starlette.sse import EventSourceResponse
        from soul_server.service.task_models import Task, TaskStatus

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=real_session_broadcaster),
        ):
            router = create_sessions_router()

            # 엔드포인트 호출
            stream_route = next(r for r in router.routes if getattr(r, 'path', '') == '/sessions/stream')
            response = await stream_route.endpoint()
            gen = response.body_iterator

            # 첫 번째 이벤트 (초기 목록) 수신
            await gen.__anext__()

            # 백그라운드에서 이벤트 브로드캐스트
            new_task = Task(
                agent_session_id="sess-new",
                prompt="New session",
                status=TaskStatus.RUNNING,
            )

            # 약간의 지연 후 이벤트 발행 (리스너 등록 대기)
            async def broadcast_after_delay():
                await asyncio.sleep(0.01)
                await real_session_broadcaster.emit_session_created(new_task)

            # 이벤트 발행과 수신을 동시에 실행
            broadcast_task = asyncio.create_task(broadcast_after_delay())

            # 두 번째 이벤트 (session_created) 수신 - 타임아웃 포함
            try:
                second_event = await asyncio.wait_for(gen.__anext__(), timeout=1.0)

                # 이벤트 검증 - dict 형태
                assert isinstance(second_event, dict)
                assert second_event["event"] == "session_created"
                assert "sess-new" in second_event["data"]
            finally:
                broadcast_task.cancel()
                await gen.aclose()

    @pytest.mark.asyncio
    async def test_listener_cleanup_on_close(self, mock_task_manager, real_session_broadcaster):
        """제너레이터 종료 시 리스너가 정리되어야 한다"""
        from soul_server.api.sessions import create_sessions_router
        from soul_server.service.task_models import Task, TaskStatus

        with (
            patch("soul_server.api.sessions.get_task_manager", return_value=mock_task_manager),
            patch("soul_server.api.sessions.get_session_broadcaster", return_value=real_session_broadcaster),
        ):
            router = create_sessions_router()

            # 초기 리스너 수 확인
            assert real_session_broadcaster.listener_count == 0

            # 엔드포인트 호출
            stream_route = next(r for r in router.routes if getattr(r, 'path', '') == '/sessions/stream')
            response = await stream_route.endpoint()
            gen = response.body_iterator

            # 첫 번째 이벤트 수신 (아직 리스너 미등록)
            await gen.__anext__()
            # 첫 번째 yield 후 일시 중단, add_listener는 아직 실행 안 됨
            assert real_session_broadcaster.listener_count == 0

            # 이벤트 발행을 백그라운드에서 예약
            async def broadcast_event():
                await asyncio.sleep(0.01)
                test_task = Task(
                    agent_session_id="sess-cleanup-test",
                    prompt="Test",
                    status=TaskStatus.RUNNING,
                )
                await real_session_broadcaster.emit_session_created(test_task)

            broadcast_task = asyncio.create_task(broadcast_event())

            # 두 번째 이벤트 수신 (이 시점에 리스너가 등록되어 있어야 함)
            try:
                await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

            # 리스너가 등록되었는지 확인
            assert real_session_broadcaster.listener_count == 1

            # 제너레이터 종료 (finally 블록에서 리스너 제거)
            await gen.aclose()

            # 리스너가 제거되었는지 확인
            await asyncio.sleep(0.01)
            assert real_session_broadcaster.listener_count == 0

            # 백그라운드 태스크 정리
            broadcast_task.cancel()
            try:
                await broadcast_task
            except asyncio.CancelledError:
                pass


# === SessionBroadcaster Unit Tests ===

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

    @pytest.mark.asyncio
    async def test_broadcast_handles_full_queue(self):
        """큐가 가득 찼을 때 에러 없이 스킵해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster

        broadcaster = SessionBroadcaster()
        # 최대 크기 1인 큐
        small_queue = asyncio.Queue(maxsize=1)
        await broadcaster.add_listener(small_queue)

        # 첫 번째 이벤트는 성공
        await broadcaster.broadcast({"type": "event1"})
        assert small_queue.qsize() == 1

        # 두 번째 이벤트는 스킵 (큐가 가득 참)
        count = await broadcaster.broadcast({"type": "event2"})
        # 큐가 가득 차서 0개에 브로드캐스트
        assert count == 0


# === TaskManager Unit Tests ===

class TestTaskManagerGetAllSessions:
    """TaskManager.get_all_sessions() 테스트"""

    @pytest.mark.asyncio
    async def test_returns_all_sessions(self):
        """모든 세션을 반환해야 한다"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        mock_db = _make_mock_session_db()
        mock_db.get_all_sessions = AsyncMock(return_value=([
            {"session_id": "sess-001", "status": "running", "prompt": "Test 1", "session_type": "claude", "created_at": "2026-03-03T02:00:00+00:00"},
            {"session_id": "sess-002", "status": "completed", "prompt": "Test 2", "session_type": "claude", "created_at": "2026-03-03T01:00:00+00:00"},
        ], 2))
        manager = TaskManager(session_db=mock_db)

        task1 = Task(agent_session_id="sess-001", prompt="Test 1", status=TaskStatus.RUNNING)
        task2 = Task(agent_session_id="sess-002", prompt="Test 2", status=TaskStatus.COMPLETED)
        manager._tasks["sess-001"] = task1
        manager._tasks["sess-002"] = task2

        sessions, total = await manager.get_all_sessions()

        assert len(sessions) == 2
        assert total == 2
        assert any(s["agent_session_id"] == "sess-001" for s in sessions)
        assert any(s["agent_session_id"] == "sess-002" for s in sessions)

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_sessions(self):
        """세션이 없을 때 빈 목록을 반환해야 한다"""
        from soul_server.service.task_manager import TaskManager

        mock_db = _make_mock_session_db()
        mock_db.get_all_sessions = AsyncMock(return_value=([], 0))
        manager = TaskManager(session_db=mock_db)
        sessions, total = await manager.get_all_sessions()

        assert sessions == []
        assert total == 0

    @pytest.mark.asyncio
    async def test_returns_sorted_by_created_at_desc(self):
        """생성일 기준 내림차순으로 반환해야 한다 (DB가 정렬하여 반환)"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        now = datetime(2026, 3, 3, 12, 0, 0, tzinfo=timezone.utc)
        mock_db = _make_mock_session_db()
        # DB가 이미 정렬된 결과를 반환
        mock_db.get_all_sessions = AsyncMock(return_value=([
            {"session_id": "sess-new", "status": "running", "prompt": "New", "session_type": "claude", "created_at": now.isoformat()},
            {"session_id": "sess-old", "status": "completed", "prompt": "Old", "session_type": "claude", "created_at": (now - timedelta(hours=2)).isoformat()},
        ], 2))
        manager = TaskManager(session_db=mock_db)

        task2 = Task(agent_session_id="sess-new", prompt="New", status=TaskStatus.RUNNING, created_at=now)
        manager._tasks["sess-new"] = task2

        sessions, total = await manager.get_all_sessions()

        # 최신이 먼저 (dict 반환)
        assert sessions[0]["agent_session_id"] == "sess-new"
        assert sessions[1]["agent_session_id"] == "sess-old"
        assert total == 2

    @pytest.mark.asyncio
    async def test_filter_by_session_type(self):
        """session_type으로 필터링 — DB에 위임"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        mock_db = _make_mock_session_db()

        async def mock_get_all_sessions(offset=0, limit=0, session_type=None):
            all_sessions = [
                {"session_id": "sess-claude", "status": "running", "prompt": "Claude task", "session_type": "claude", "created_at": "2026-03-03T02:00:00+00:00"},
                {"session_id": "sess-llm", "status": "running", "prompt": "LLM task", "session_type": "llm", "created_at": "2026-03-03T01:00:00+00:00"},
            ]
            if session_type:
                filtered = [s for s in all_sessions if s["session_type"] == session_type]
                return filtered, len(filtered)
            return all_sessions, len(all_sessions)

        mock_db.get_all_sessions = mock_get_all_sessions
        manager = TaskManager(session_db=mock_db)

        claude_task = Task(agent_session_id="sess-claude", prompt="Claude task", status=TaskStatus.RUNNING, session_type="claude")
        llm_task = Task(agent_session_id="sess-llm", prompt="LLM task", status=TaskStatus.RUNNING, session_type="llm")
        manager._tasks["sess-claude"] = claude_task
        manager._tasks["sess-llm"] = llm_task

        # 전체
        sessions, total = await manager.get_all_sessions()
        assert total == 2

        # claude만
        sessions, total = await manager.get_all_sessions(session_type="claude")
        assert total == 1
        assert sessions[0]["agent_session_id"] == "sess-claude"

        # llm만
        sessions, total = await manager.get_all_sessions(session_type="llm")
        assert total == 1
        assert sessions[0]["agent_session_id"] == "sess-llm"

        # 없는 타입
        sessions, total = await manager.get_all_sessions(session_type="nonexistent")
        assert total == 0
        assert sessions == []

    @pytest.mark.asyncio
    async def test_filter_and_pagination_combined(self):
        """session_type 필터와 페이지네이션 조합 — DB에 위임"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        mock_db = _make_mock_session_db()

        now = datetime(2026, 3, 3, 12, 0, 0, tzinfo=timezone.utc)
        all_claude = [
            {"session_id": f"sess-claude-{i:03d}", "status": "completed", "prompt": f"Claude {i}", "session_type": "claude", "created_at": (now + timedelta(hours=i)).isoformat()}
            for i in range(5)
        ]

        async def mock_get_all_sessions(offset=0, limit=0, session_type=None):
            filtered = all_claude if session_type == "claude" else all_claude
            total = len(filtered)
            if offset:
                filtered = filtered[offset:]
            if limit:
                filtered = filtered[:limit]
            return filtered, total

        mock_db.get_all_sessions = mock_get_all_sessions
        manager = TaskManager(session_db=mock_db)

        # claude만 + 페이지네이션
        sessions, total = await manager.get_all_sessions(
            session_type="claude", offset=1, limit=2,
        )
        assert total == 5  # 전체 claude 수
        assert len(sessions) == 2  # limit=2

    @pytest.mark.asyncio
    async def test_pagination_offset_limit(self):
        """offset과 limit으로 페이지네이션 — DB에 위임"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        mock_db = _make_mock_session_db()

        now = datetime(2026, 3, 3, 12, 0, 0, tzinfo=timezone.utc)
        all_sessions_data = [
            {"session_id": f"sess-{i:03d}", "status": "completed", "prompt": f"Task {i}", "session_type": "claude", "created_at": (now + timedelta(hours=i)).isoformat()}
            for i in range(5)
        ]

        async def mock_get_all_sessions(offset=0, limit=0, session_type=None):
            total = len(all_sessions_data)
            result = all_sessions_data[offset:]
            if limit:
                result = result[:limit]
            return result, total

        mock_db.get_all_sessions = mock_get_all_sessions
        manager = TaskManager(session_db=mock_db)

        # 전체
        sessions, total = await manager.get_all_sessions()
        assert len(sessions) == 5
        assert total == 5

        # offset=2, limit=2
        sessions, total = await manager.get_all_sessions(offset=2, limit=2)
        assert len(sessions) == 2
        assert total == 5

        # offset=0, limit=3
        sessions, total = await manager.get_all_sessions(offset=0, limit=3)
        assert len(sessions) == 3
        assert total == 5


# === Session Info Serialization Tests ===

class TestSessionInfoSerialization:
    """세션 정보 직렬화 테스트 — Task.to_session_info() 메서드"""

    def test_to_session_info(self):
        """Task가 세션 정보 dict로 올바르게 변환되어야 한다"""
        from soul_server.service.task_models import Task, TaskStatus

        task = Task(
            agent_session_id="sess-001",
            prompt="Hello",
            status=TaskStatus.RUNNING,
            created_at=datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc),
        )

        info = task.to_session_info()

        assert info["agent_session_id"] == "sess-001"
        assert info["status"] == "running"
        assert info["prompt"] == "Hello"
        assert info["session_type"] == "claude"
        assert info["pid"] is None
        assert "created_at" in info
        assert "updated_at" in info

    def test_to_session_info_completed(self):
        """완료된 Task의 updated_at은 completed_at이어야 한다"""
        from soul_server.service.task_models import Task, TaskStatus

        created = datetime(2026, 3, 3, 1, 0, 0, tzinfo=timezone.utc)
        completed = datetime(2026, 3, 3, 2, 0, 0, tzinfo=timezone.utc)

        task = Task(
            agent_session_id="sess-001",
            prompt="Hello",
            status=TaskStatus.COMPLETED,
            created_at=created,
            completed_at=completed,
        )

        info = task.to_session_info()

        assert info["updated_at"] == completed.isoformat()

    def test_to_session_info_llm_type(self):
        """LLM 타입 세션이 올바르게 변환되어야 한다"""
        from soul_server.service.task_models import Task, TaskStatus

        task = Task(
            agent_session_id="sess-llm-001",
            prompt="LLM prompt",
            status=TaskStatus.RUNNING,
            session_type="llm",
            pid=12345,
        )

        info = task.to_session_info()

        assert info["session_type"] == "llm"
        assert info["pid"] == 12345


# === TC-8: Non-existent Session Intervention ===

class TestNonExistentSessionIntervention:
    """TC-8: 존재하지 않는 세션에 개입 시 404 반환"""

    @pytest.mark.asyncio
    async def test_intervene_nonexistent_session_raises_error(self):
        """존재하지 않는 세션에 개입 시 TaskNotFoundError가 발생해야 한다"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import TaskNotFoundError

        manager = TaskManager(session_db=_make_mock_session_db())

        # 존재하지 않는 세션에 개입 시도
        with pytest.raises(TaskNotFoundError) as exc_info:
            await manager.add_intervention(
                agent_session_id="nonexistent-session-id",
                text="Hello",
                user="test-user",
            )

        assert "nonexistent-session-id" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_get_task_returns_none_for_nonexistent_session(self):
        """존재하지 않는 세션 조회 시 None을 반환해야 한다"""
        from soul_server.service.task_manager import TaskManager

        manager = TaskManager(session_db=_make_mock_session_db())

        # 존재하지 않는 세션 조회
        task = await manager.get_task("nonexistent-session-id")
        assert task is None


# === TC-10: Concurrent Sessions ===

class TestConcurrentSessions:
    """TC-10: 동시에 여러 세션 실행"""

    @pytest.mark.asyncio
    async def test_multiple_sessions_in_list(self):
        """여러 세션이 동시에 목록에 표시되어야 한다"""
        from soul_server.service.task_manager import TaskManager
        from soul_server.service.task_models import Task, TaskStatus

        mock_db = _make_mock_session_db()
        mock_db.get_all_sessions = AsyncMock(return_value=([
            {"session_id": "sess-a", "status": "running", "prompt": "Task A", "session_type": "claude", "created_at": "2026-03-03T02:00:00+00:00"},
            {"session_id": "sess-b", "status": "running", "prompt": "Task B", "session_type": "claude", "created_at": "2026-03-03T01:00:00+00:00"},
            {"session_id": "sess-c", "status": "running", "prompt": "Task C", "session_type": "claude", "created_at": "2026-03-03T00:00:00+00:00"},
        ], 3))
        manager = TaskManager(session_db=mock_db)

        # 여러 세션 생성
        task_a = Task(agent_session_id="sess-a", prompt="Task A", status=TaskStatus.RUNNING)
        task_b = Task(agent_session_id="sess-b", prompt="Task B", status=TaskStatus.RUNNING)
        task_c = Task(agent_session_id="sess-c", prompt="Task C", status=TaskStatus.RUNNING)

        manager._tasks["sess-a"] = task_a
        manager._tasks["sess-b"] = task_b
        manager._tasks["sess-c"] = task_c

        sessions, total = await manager.get_all_sessions()

        # 모든 세션이 목록에 있어야 함 (dict 반환)
        assert len(sessions) == 3
        assert total == 3
        session_ids = [s["agent_session_id"] for s in sessions]
        assert "sess-a" in session_ids
        assert "sess-b" in session_ids
        assert "sess-c" in session_ids


# === TC-11: Multiple Clients on Same Session SSE ===

class TestMultipleClientsSSE:
    """TC-11: 같은 세션에 여러 클라이언트 SSE 접속"""

    @pytest.mark.asyncio
    async def test_multiple_listeners_receive_same_event(self):
        """여러 리스너가 같은 이벤트를 수신해야 한다"""
        from soul_server.service.session_broadcaster import SessionBroadcaster
        from soul_server.service.task_models import Task, TaskStatus

        broadcaster = SessionBroadcaster()

        # 두 클라이언트의 큐
        client_a_queue = asyncio.Queue()
        client_b_queue = asyncio.Queue()

        await broadcaster.add_listener(client_a_queue)
        await broadcaster.add_listener(client_b_queue)

        # 이벤트 발행
        task = Task(
            agent_session_id="sess-shared",
            prompt="Shared session",
            status=TaskStatus.RUNNING,
        )
        await broadcaster.emit_session_created(task)

        # 두 클라이언트 모두 동일한 이벤트 수신
        event_a = await client_a_queue.get()
        event_b = await client_b_queue.get()

        assert event_a["type"] == "session_created"
        assert event_b["type"] == "session_created"
        assert event_a["session"]["agent_session_id"] == "sess-shared"
        assert event_b["session"]["agent_session_id"] == "sess-shared"
