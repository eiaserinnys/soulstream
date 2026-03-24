"""Tests for SessionRouter routing logic."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_router import SessionRouter


@pytest.fixture
def manager():
    return NodeManager()


@pytest.fixture
def router(manager):
    return SessionRouter(manager)


def make_mock_node(node_id, session_count=0):
    """Create a mock NodeConnection with controllable session_count."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    node = NodeConnection(ws=ws, node_id=node_id)
    # Add fake sessions to control session_count
    for i in range(session_count):
        node._sessions[f"sess-{node_id}-{i}"] = {"agentSessionId": f"sess-{node_id}-{i}"}
    return node


class TestRouting:
    """SessionRouter routing tests."""

    async def test_routes_to_specified_node(self, manager, router):
        """When nodeId is specified, routes to that node."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node._pending:
                node._pending[req_id].set_result({"agentSessionId": "created-sess"})

        ws.send_json.side_effect = resolve_on_send

        node = await manager.register_node(ws, {"node_id": "target-node"})

        session_id, node_id = await router.route_create_session({
            "nodeId": "target-node",
            "prompt": "hello",
        })

        assert node_id == "target-node"
        assert session_id == "created-sess"

    async def test_auto_selects_least_sessions_node(self, manager, router):
        """Without nodeId, selects the node with fewest sessions."""
        # Register two nodes
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        node1 = await manager.register_node(ws1, {"node_id": "busy-node"})
        node2 = await manager.register_node(ws2, {"node_id": "idle-node"})

        # Give node1 more sessions
        node1._sessions["s1"] = {}
        node1._sessions["s2"] = {}
        # node2 has 0 sessions

        async def resolve_on_send(data):
            req_id = data.get("requestId")
            if req_id and req_id in node2._pending:
                node2._pending[req_id].set_result({"agentSessionId": "new-sess"})

        ws2.send_json.side_effect = resolve_on_send

        session_id, node_id = await router.route_create_session({"prompt": "test"})

        assert node_id == "idle-node"

    async def test_raises_503_when_no_nodes(self, router):
        """Raises HTTPException 503 when no nodes are connected."""
        with pytest.raises(HTTPException) as exc_info:
            await router.route_create_session({"prompt": "test"})

        assert exc_info.value.status_code == 503
        assert "No nodes available" in exc_info.value.detail

    async def test_raises_404_when_specified_node_not_found(self, manager, router):
        """Raises HTTPException 404 when specified node doesn't exist."""
        # Register a different node so there are connected nodes
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await manager.register_node(ws, {"node_id": "other-node"})

        with pytest.raises(HTTPException) as exc_info:
            await router.route_create_session({
                "nodeId": "nonexistent-node",
                "prompt": "test",
            })

        assert exc_info.value.status_code == 404
        assert "nonexistent-node" in exc_info.value.detail
