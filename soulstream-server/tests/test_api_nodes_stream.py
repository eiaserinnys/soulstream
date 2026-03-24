"""Tests for Nodes SSE stream (/api/nodes/stream).

Validates the SSE event contract that the orchestrator-dashboard client expects:
- snapshot: bare OrchestratorNode[] array (not wrapped in {"nodes": [...]})
- node_connected / node_disconnected event type mapping
"""

import json

import pytest
from unittest.mock import AsyncMock

from soulstream_server.api.nodes import _EVENT_TYPE_MAP


class TestNodeStreamEventTypeMapping:
    """Internal event types are mapped to client-expected SSE event names."""

    async def test_node_registered_maps_to_node_connected(self):
        """node_registered internal event → node_connected SSE event."""
        assert _EVENT_TYPE_MAP["node_registered"] == "node_connected"

    async def test_node_unregistered_maps_to_node_disconnected(self):
        """node_unregistered internal event → node_disconnected SSE event."""
        assert _EVENT_TYPE_MAP["node_unregistered"] == "node_disconnected"

    async def test_unmapped_types_pass_through(self):
        """Event types not in the map should pass through unchanged."""
        assert "node_session_created" not in _EVENT_TYPE_MAP


class TestNodeSnapshotFormat:
    """Validates the snapshot SSE data format."""

    async def test_snapshot_is_bare_array(self, node_manager):
        """The snapshot event data should be a JSON array, not an object."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "n1",
            "host": "10.0.0.1",
            "port": 4100,
            "capabilities": ["session"],
        })

        nodes = node_manager.get_nodes()
        snapshot_data = json.dumps(nodes)
        parsed = json.loads(snapshot_data)

        assert isinstance(parsed, list), (
            f"snapshot data should be a bare array, got: {type(parsed)}"
        )
        assert len(parsed) == 1
        assert parsed[0]["nodeId"] == "n1"
        assert parsed[0]["status"] == "connected"
        assert "sessionCount" in parsed[0]

    async def test_snapshot_empty_is_empty_array(self, node_manager):
        """With no nodes connected, snapshot data is an empty array."""
        nodes = node_manager.get_nodes()
        parsed = json.loads(json.dumps(nodes))

        assert isinstance(parsed, list)
        assert len(parsed) == 0

    async def test_node_info_has_orchestrator_node_fields(self, node_manager):
        """Node info matches the OrchestratorNode TypeScript interface."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "info-node",
            "host": "localhost",
            "port": 4100,
            "capabilities": ["session"],
        })

        node = node_manager.get_nodes()[0]
        required_fields = {"nodeId", "host", "port", "status", "capabilities", "connectedAt", "sessionCount"}
        assert required_fields.issubset(node.keys()), (
            f"Missing fields: {required_fields - node.keys()}"
        )
