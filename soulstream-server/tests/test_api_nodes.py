"""Tests for Nodes API (/api/nodes)."""

from unittest.mock import AsyncMock

import pytest

from soulstream_server.api.nodes import _detect_portrait_mime


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
            "node_id": "node-a",
            "host": "10.0.0.1",
            "port": 4100,
        })
        await node_manager.register_node(ws2, {
            "node_id": "node-b",
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
            "node_id": "info-node",
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


class TestDetectPortraitMime:
    """_detect_portrait_mime magic bytes 테스트."""

    def test_png(self):
        assert _detect_portrait_mime(b"\x89PNG\r\n\x1a\n") == "image/png"

    def test_jpeg(self):
        assert _detect_portrait_mime(b"\xff\xd8\xff\xe0") == "image/jpeg"

    def test_webp(self):
        data = b"RIFF\x00\x00\x00\x00WEBP"
        assert _detect_portrait_mime(data) == "image/webp"

    def test_gif(self):
        assert _detect_portrait_mime(b"GIF89a") == "image/gif"

    def test_unknown_returns_octet_stream(self):
        assert _detect_portrait_mime(b"\x00\x01\x02\x03") == "application/octet-stream"


class TestPortraitProxy:
    """portrait 캐시 서빙 테스트."""

    async def test_portrait_cache_hit_returns_bytes(self, client, node_manager):
        """portrait_cache에 데이터가 있으면 HTTP 없이 바로 반환."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {
            "node_id": "n1", "host": "10.0.0.1", "port": 4100,
        })
        portrait_bytes = b"\x89PNGfakeportrait"
        node.set_agent_data({"agent-1": {"name": "A"}}, {"agent-1": portrait_bytes})

        resp = await client.get("/api/nodes/n1/agents/agent-1/portrait")

        assert resp.status_code == 200
        assert resp.content == portrait_bytes
        assert resp.headers["content-type"].startswith("image/png")

    async def test_portrait_cache_miss_proxies_http(self, client, node_manager):
        """portrait_cache에 없으면 soul-server HTTP 프록시 호출 — 연결 불가 시 502."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 9999,
        })

        resp = await client.get("/api/nodes/n1/agents/agent-1/portrait")

        # 9999 포트에 서버 없음 → 연결 실패 → 502
        assert resp.status_code in (502, 503, 504)
