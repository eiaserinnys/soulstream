"""Tests for NodeManager node tracking and change events."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from soulstream_server.nodes.node_manager import NodeManager


@pytest.fixture
def manager():
    return NodeManager()


@pytest.fixture
def mock_ws():
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


def make_registration(node_id="node-1", host="localhost", port=4100):
    return {"nodeId": node_id, "host": host, "port": port, "capabilities": ["session"]}


class TestRegisterNode:
    """register_node tests."""

    async def test_register_node_adds_to_map(self, manager, mock_ws):
        """register_node adds the node to internal map."""
        node = await manager.register_node(mock_ws, make_registration("node-a"))

        assert node.node_id == "node-a"
        assert manager.get_node("node-a") is node
        assert len(manager.get_connected_nodes()) == 1

    async def test_register_node_duplicate_replaces_old(self, manager):
        """Registering the same node_id closes old connection and replaces."""
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        old_node = await manager.register_node(ws1, make_registration("node-dup"))
        new_node = await manager.register_node(ws2, make_registration("node-dup"))

        assert manager.get_node("node-dup") is new_node
        assert manager.get_node("node-dup") is not old_node
        # Old connection should have been closed
        ws1.close.assert_called_once()

    async def test_register_node_preserves_host_and_port(self, manager, mock_ws):
        """register_node preserves host/port from registration data."""
        node = await manager.register_node(
            mock_ws, make_registration("n1", "10.0.0.1", 5000)
        )

        assert node.host == "10.0.0.1"
        assert node.port == 5000


class TestUnregisterNode:
    """unregister_node tests."""

    async def test_unregister_removes_from_map(self, manager, mock_ws):
        """unregister_node removes the node from the map."""
        await manager.register_node(mock_ws, make_registration("node-x"))
        assert manager.get_node("node-x") is not None

        manager.unregister_node("node-x")

        assert manager.get_node("node-x") is None
        assert len(manager.get_connected_nodes()) == 0

    async def test_unregister_nonexistent_is_noop(self, manager):
        """unregister_node with unknown node_id does not raise."""
        manager.unregister_node("ghost-node")  # Should not raise


class TestGetConnectedNodes:
    """get_connected_nodes tests."""

    async def test_returns_all_registered_nodes(self, manager):
        """get_connected_nodes returns all registered nodes."""
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        await manager.register_node(ws1, make_registration("n1"))
        await manager.register_node(ws2, make_registration("n2"))

        nodes = manager.get_connected_nodes()
        ids = {n.node_id for n in nodes}
        assert ids == {"n1", "n2"}

    async def test_get_nodes_returns_info_dicts(self, manager, mock_ws):
        """get_nodes returns serialized node info dicts."""
        await manager.register_node(mock_ws, make_registration("n1"))

        infos = manager.get_nodes()
        assert len(infos) == 1
        assert infos[0]["nodeId"] == "n1"
        assert infos[0]["status"] == "connected"


class TestFindNodeForSession:
    """find_node_for_session tests."""

    async def test_finds_node_with_matching_session(self, manager, mock_ws):
        """find_node_for_session returns the node holding the session."""
        node = await manager.register_node(mock_ws, make_registration("n1"))
        node._sessions["sess-abc"] = {"agentSessionId": "sess-abc"}

        found = manager.find_node_for_session("sess-abc")
        assert found is node

    async def test_returns_none_for_unknown_session(self, manager, mock_ws):
        """find_node_for_session returns None for unknown session."""
        await manager.register_node(mock_ws, make_registration("n1"))

        assert manager.find_node_for_session("no-such-sess") is None


class TestChangeListeners:
    """Change listener event tests."""

    async def test_listener_receives_register_event(self, manager, mock_ws):
        """Change listeners receive node_registered events."""
        events = []

        async def listener(event_type, node_id, data):
            events.append((event_type, node_id))

        manager.add_change_listener(listener)
        await manager.register_node(mock_ws, make_registration("n1"))

        assert len(events) == 1
        assert events[0] == ("node_registered", "n1")

    async def test_listener_receives_unregister_event(self, manager, mock_ws):
        """Change listeners receive node_unregistered events via on_close."""
        events = []

        async def listener(event_type, node_id, data):
            events.append((event_type, node_id))

        manager.add_change_listener(listener)
        node = await manager.register_node(mock_ws, make_registration("n1"))

        # Simulate node close (which calls _on_node_close)
        await node.close()

        assert ("node_unregistered", "n1") in events

    async def test_remove_change_listener(self, manager, mock_ws):
        """Removed listener no longer receives events."""
        events = []

        async def listener(event_type, node_id, data):
            events.append(event_type)

        manager.add_change_listener(listener)
        manager.remove_change_listener(listener)
        await manager.register_node(mock_ws, make_registration("n1"))

        assert len(events) == 0
