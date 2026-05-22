"""Tests for execute-proxy endpoint (POST /api/execute).

soul-server 호환 execute-proxy: 세션 생성/재개 + SSE 이벤트 스트리밍을 단일 요청으로 통합.
New 모드 (agent_session_id 없음), Resume 모드 (agent_session_id 있음), 에러 케이스를 검증한다.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from tests.conftest import TEST_AUTH_TOKEN


@pytest.fixture
def mock_db():
    """Mock PostgresSessionDB with async methods."""
    db = MagicMock()
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.get_session = AsyncMock(return_value=None)
    db.read_events = AsyncMock(return_value=[])
    db.assign_session_to_folder = AsyncMock()
    db.get_all_folders = AsyncMock(return_value=[])
    db.create_folder = AsyncMock()
    db.update_folder = AsyncMock()
    db.delete_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return db


@pytest.fixture
def mock_node():
    """Mock NodeConnection for execute-proxy tests."""
    node = MagicMock()
    node.node_id = "test-node-1"
    node.send_create_session = AsyncMock(return_value={"agentSessionId": "sess-123"})
    node.send_subscribe_events = AsyncMock(return_value="sub-1")
    node.send_intervene = AsyncMock(return_value={"ok": True})
    node.unsubscribe_events = MagicMock()
    return node


@pytest.fixture
def mock_session_router(mock_node):
    """Mock SessionRouter that returns a session ID and node ID."""
    router = MagicMock()
    router.route_create_session = AsyncMock(return_value=("sess-123", "test-node-1"))
    return router


@pytest.fixture
def mock_node_manager(mock_node):
    """Mock NodeManager."""
    nm = MagicMock()
    nm.get_node = MagicMock(return_value=mock_node)
    nm.get_connected_nodes = MagicMock(return_value=[mock_node])
    nm.find_node_for_session = MagicMock(return_value=mock_node)
    return nm


@pytest.fixture
def mock_catalog_service():
    """Mock CatalogService."""
    cs = MagicMock()
    cs.broadcast_catalog = AsyncMock()
    cs.list_folders = AsyncMock(return_value=[])
    cs.create_folder = AsyncMock(return_value={"id": "f1", "name": "Test", "sortOrder": 0})
    cs.rename_folder = AsyncMock()
    cs.update_folder = AsyncMock()
    cs.delete_folder = AsyncMock()
    cs.reorder_folders = AsyncMock()
    cs.move_sessions_to_folder = AsyncMock()
    cs.rename_session = AsyncMock()
    cs.delete_session = AsyncMock()
    cs.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return cs


@pytest.fixture
def exec_app(mock_db, mock_node_manager, mock_session_router, mock_catalog_service):
    """FastAPI app with execute-proxy router mounted."""
    from soulstream_server.main import create_app
    from soulstream_server.service.session_broadcaster import SessionBroadcaster

    broadcaster = SessionBroadcaster()
    return create_app(
        db=mock_db,
        node_manager=mock_node_manager,
        session_router=mock_session_router,
        broadcaster=broadcaster,
        catalog_service=mock_catalog_service,
    )


@pytest.fixture
async def exec_client(exec_app):
    """HTTP client for execute-proxy tests."""
    transport = ASGITransport(app=exec_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {TEST_AUTH_TOKEN}"},
    ) as c:
        yield c


def _parse_sse_events(text: str) -> list[dict]:
    """Parse SSE response text into list of event dicts."""
    events = []
    current = {}
    for line in text.replace("\r\n", "\n").split("\n"):
        line = line.strip()
        if line.startswith("event: "):
            current["event"] = line[7:]
        elif line.startswith("data: "):
            current["data"] = line[6:]
        elif line.startswith("id: "):
            current["id"] = line[4:]
        elif line == "" and current:
            events.append(current)
            current = {}
    if current:
        events.append(current)
    return events


class TestNewMode:
    """POST /api/execute without agent_session_id — New session mode."""

    async def test_new_session_returns_sse_with_init(
        self, exec_client, mock_session_router, mock_node_manager, mock_node
    ):
        """New mode: returns SSE stream starting with init event."""
        # Set up the subscribe to emit a complete event then sentinel
        async def fake_subscribe(session_id, callback):
            async def emit_events():
                await asyncio.sleep(0.01)
                await callback({
                    "event": {
                        "type": "complete",
                        "result": "done",
                        "_event_id": 1,
                    }
                })
            asyncio.create_task(emit_events())
            return "sub-1"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        resp = await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
        })
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

        events = _parse_sse_events(resp.text)
        # First event should be init
        init_events = [e for e in events if e.get("event") == "init"]
        assert len(init_events) >= 1
        init_data = json.loads(init_events[0]["data"])
        assert init_data["agent_session_id"] == "sess-123"
        assert init_data["node_id"] == "test-node-1"

    async def test_new_session_calls_route_create_session(
        self, exec_client, mock_session_router, mock_node_manager, mock_node
    ):
        """New mode: calls session_router.route_create_session with correct params."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "complete", "_event_id": 1}})
            asyncio.create_task(emit())
            return "sub-1"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
            "model": "claude-sonnet",
            "reasoningEffort": "high",
        })

        mock_session_router.route_create_session.assert_called_once()
        call_args = mock_session_router.route_create_session.call_args[0][0]
        assert call_args["prompt"] == "hello"
        assert call_args["profile"] == "test-agent"
        assert call_args["model"] == "claude-sonnet"
        assert call_args["reasoningEffort"] == "high"

    async def test_new_session_broadcasts_catalog(
        self, exec_client, mock_session_router, mock_node_manager, mock_node, mock_catalog_service
    ):
        """New mode: calls catalog_service.broadcast_catalog after session creation."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "complete", "_event_id": 1}})
            asyncio.create_task(emit())
            return "sub-1"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
        })

        mock_catalog_service.broadcast_catalog.assert_called()

    async def test_new_session_context_items_converted(
        self, exec_client, mock_session_router, mock_node_manager, mock_node
    ):
        """New mode: context_items are passed as extra_context_items."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "complete", "_event_id": 1}})
            asyncio.create_task(emit())
            return "sub-1"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        ctx = [{"key": "test", "label": "Test", "content": "test content"}]
        await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
            "context_items": ctx,
        })

        call_args = mock_session_router.route_create_session.call_args[0][0]
        assert call_args["extra_context_items"] == ctx


class TestResumeMode:
    """POST /api/execute with agent_session_id — Resume session mode."""

    async def test_resume_returns_sse_with_init(
        self, exec_client, mock_node_manager, mock_node, mock_db
    ):
        """Resume mode: returns SSE stream with init event."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({
                    "event": {
                        "type": "complete",
                        "result": "resumed",
                        "_event_id": 2,
                    }
                })
            asyncio.create_task(emit())
            return "sub-2"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        resp = await exec_client.post("/api/execute", json={
            "prompt": "continue",
            "agent_session_id": "existing-sess",
        })

        assert resp.status_code == 200
        events = _parse_sse_events(resp.text)
        init_events = [e for e in events if e.get("event") == "init"]
        assert len(init_events) >= 1
        init_data = json.loads(init_events[0]["data"])
        assert init_data["agent_session_id"] == "existing-sess"

    async def test_resume_calls_intervene(
        self, exec_client, mock_node_manager, mock_node, mock_db
    ):
        """Resume mode: calls send_intervene with the prompt."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "complete", "_event_id": 2}})
            asyncio.create_task(emit())
            return "sub-2"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        await exec_client.post("/api/execute", json={
            "prompt": "continue please",
            "agent_session_id": "existing-sess",
        })

        mock_node.send_intervene.assert_called_once()
        call_args = mock_node.send_intervene.call_args
        assert call_args[0][0] == "existing-sess"
        assert call_args[0][1] == "continue please"

    async def test_resume_subscribes_before_intervene(
        self, exec_client, mock_node_manager, mock_node, mock_db
    ):
        """Resume mode: subscribes events before sending intervene."""
        call_order = []

        async def track_subscribe(session_id, callback):
            call_order.append("subscribe")
            async def emit():
                await asyncio.sleep(0.05)
                await callback({"event": {"type": "complete", "_event_id": 2}})
            asyncio.create_task(emit())
            return "sub-2"

        async def track_intervene(*args, **kwargs):
            call_order.append("intervene")
            return {"ok": True}

        mock_node.send_subscribe_events = AsyncMock(side_effect=track_subscribe)
        mock_node.send_intervene = AsyncMock(side_effect=track_intervene)

        await exec_client.post("/api/execute", json={
            "prompt": "continue",
            "agent_session_id": "existing-sess",
        })

        assert call_order == ["subscribe", "intervene"]


class TestSSEFormat:
    """SSE event format verification."""

    async def test_events_include_event_id(
        self, exec_client, mock_session_router, mock_node_manager, mock_node
    ):
        """Events with _event_id are emitted with SSE id field."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({
                    "event": {
                        "type": "thinking",
                        "content": "...",
                        "_event_id": 42,
                    }
                })
                await asyncio.sleep(0.01)
                await callback({
                    "event": {
                        "type": "complete",
                        "_event_id": 43,
                    }
                })
            asyncio.create_task(emit())
            return "sub-1"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        resp = await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
        })
        events = _parse_sse_events(resp.text)

        thinking_events = [e for e in events if e.get("event") == "thinking"]
        assert len(thinking_events) >= 1
        assert thinking_events[0].get("id") == "42"

    async def test_complete_event_terminates_stream(
        self, exec_client, mock_session_router, mock_node_manager, mock_node
    ):
        """Stream terminates after complete event."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "complete", "_event_id": 1}})
                # This event should NOT appear
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "thinking", "_event_id": 2}})
            asyncio.create_task(emit())
            return "sub-1"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        resp = await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
        })
        events = _parse_sse_events(resp.text)

        event_types = [e.get("event") for e in events]
        assert "complete" in event_types
        # No events after complete
        complete_idx = event_types.index("complete")
        remaining = event_types[complete_idx + 1:]
        assert "thinking" not in remaining


class TestErrorHandling:
    """Error handling scenarios."""

    async def test_no_nodes_returns_503_in_sse(
        self, exec_client, mock_session_router, mock_node_manager
    ):
        """When no nodes available, route_create_session raises 503."""
        from fastapi import HTTPException
        mock_session_router.route_create_session = AsyncMock(
            side_effect=HTTPException(status_code=503, detail="No nodes available")
        )

        resp = await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
        })
        assert resp.status_code == 503

    async def test_new_session_without_profile_returns_422(
        self, exec_client, mock_session_router
    ):
        """New mode에서 profile/agentId가 없으면 노드까지 보내지 않고 명확한 422를 반환한다."""
        resp = await exec_client.post("/api/execute", json={"prompt": "hello"})

        assert resp.status_code == 422
        assert resp.json()["detail"]["error"]["code"] == "AGENT_PROFILE_REQUIRED"
        mock_session_router.route_create_session.assert_not_called()

    async def test_resume_session_not_found_returns_404(
        self, exec_client, mock_node_manager, mock_db
    ):
        """Resume mode: when session node not found, returns 404."""
        mock_node_manager.find_node_for_session = MagicMock(return_value=None)
        mock_node_manager.get_connected_nodes = MagicMock(return_value=[])
        mock_db.get_session = AsyncMock(return_value=None)

        resp = await exec_client.post("/api/execute", json={
            "prompt": "continue",
            "agent_session_id": "nonexistent-sess",
        })
        assert resp.status_code == 404

    async def test_unsubscribes_on_completion(
        self, exec_client, mock_session_router, mock_node_manager, mock_node
    ):
        """Verifies cleanup: unsubscribe_events called after stream completes."""
        async def fake_subscribe(session_id, callback):
            async def emit():
                await asyncio.sleep(0.01)
                await callback({"event": {"type": "complete", "_event_id": 1}})
            asyncio.create_task(emit())
            return "sub-cleanup"

        mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)

        await exec_client.post("/api/execute", json={
            "prompt": "hello",
            "profile": "test-agent",
        })

        mock_node.unsubscribe_events.assert_called_once_with("sess-123", "sub-cleanup")


class TestFindSessionNode:
    """Tests for find_session_node utility function."""

    async def test_finds_node_in_memory(self, mock_node_manager, mock_db, mock_node):
        """find_session_node: finds node via in-memory lookup."""
        from soulstream_server.api.node_utils import find_session_node

        result = await find_session_node("sess-1", mock_db, mock_node_manager)
        assert result == mock_node
        mock_node_manager.find_node_for_session.assert_called_with("sess-1")

    async def test_falls_back_to_db(self, mock_db, mock_node):
        """find_session_node: falls back to DB when not in memory."""
        from soulstream_server.api.node_utils import find_session_node

        nm = MagicMock()
        nm.find_node_for_session = MagicMock(return_value=None)
        nm.get_node = MagicMock(return_value=mock_node)
        nm.get_connected_nodes = MagicMock(return_value=[mock_node])
        mock_db.get_session = AsyncMock(return_value={"node_id": "test-node-1"})

        result = await find_session_node("sess-1", mock_db, nm)
        assert result == mock_node
        mock_db.get_session.assert_called_with("sess-1")

    async def test_falls_back_to_active_node(self, mock_db, mock_node):
        """find_session_node: falls back to first active node."""
        from soulstream_server.api.node_utils import find_session_node

        nm = MagicMock()
        nm.find_node_for_session = MagicMock(return_value=None)
        nm.get_node = MagicMock(return_value=None)
        nm.get_connected_nodes = MagicMock(return_value=[mock_node])
        mock_db.get_session = AsyncMock(return_value=None)

        result = await find_session_node("sess-1", mock_db, nm)
        assert result == mock_node

    async def test_raises_404_when_no_node(self, mock_db):
        """find_session_node: raises HTTPException 404 when no node found."""
        from fastapi import HTTPException
        from soulstream_server.api.node_utils import find_session_node

        nm = MagicMock()
        nm.find_node_for_session = MagicMock(return_value=None)
        nm.get_node = MagicMock(return_value=None)
        nm.get_connected_nodes = MagicMock(return_value=[])
        mock_db.get_session = AsyncMock(return_value=None)

        with pytest.raises(HTTPException) as exc_info:
            await find_session_node("sess-1", mock_db, nm)
        assert exc_info.value.status_code == 404
