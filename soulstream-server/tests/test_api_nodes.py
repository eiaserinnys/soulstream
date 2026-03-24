"""Tests for Nodes API (/api/nodes)."""

from unittest.mock import AsyncMock

import pytest


class TestListNodes:
    """GET /api/nodes tests."""

    async def test_returns_empty_list(self, client):
        """Returns empty node list when none connected."""
        resp = await client.get("/api/nodes")

        assert resp.status_code == 200
        body = resp.json()
        assert body["nodes"] == []

    async def test_returns_registered_nodes(self, client, node_manager):
        """Returns info for all registered nodes."""
        ws1 = AsyncMock()
        ws1.send_json = AsyncMock()
        ws1.close = AsyncMock()
        ws2 = AsyncMock()
        ws2.send_json = AsyncMock()
        ws2.close = AsyncMock()

        await node_manager.register_node(ws1, {
            "nodeId": "node-a",
            "host": "10.0.0.1",
            "port": 4100,
        })
        await node_manager.register_node(ws2, {
            "nodeId": "node-b",
            "host": "10.0.0.2",
            "port": 4101,
        })

        resp = await client.get("/api/nodes")

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["nodes"]) == 2
        node_ids = {n["nodeId"] for n in body["nodes"]}
        assert node_ids == {"node-a", "node-b"}

    async def test_node_info_fields(self, client, node_manager):
        """Node info contains expected fields."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()

        await node_manager.register_node(ws, {
            "nodeId": "info-node",
            "host": "localhost",
            "port": 4100,
            "capabilities": ["session", "mcp"],
        })

        resp = await client.get("/api/nodes")

        node_info = resp.json()["nodes"][0]
        assert node_info["nodeId"] == "info-node"
        assert node_info["host"] == "localhost"
        assert node_info["port"] == 4100
        assert node_info["capabilities"] == ["session", "mcp"]
        assert node_info["status"] == "connected"
        assert node_info["sessionCount"] == 0
        assert "connectedAt" in node_info
