"""Tests for Nodes API (/api/nodes)."""

from unittest.mock import AsyncMock, MagicMock

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


class TestListNodeAgents:
    """GET /api/nodes/{node_id}/agents tests."""

    async def test_returns_backend_for_agent_profiles(self, client, node_manager):
        """노드 agent 목록은 optimistic session 배지에 필요한 backend를 포함한다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {
            "node_id": "n1", "host": "10.0.0.1", "port": 4100,
        })
        node.set_agent_data({
            "codex-default": {
                "name": "Codex Default",
                "portrait_url": "/api/agents/codex-default/portrait",
                "max_turns": None,
                "backend": "codex",
            },
        }, {})

        resp = await client.get("/api/nodes/n1/agents")

        assert resp.status_code == 200
        agent = resp.json()["agents"][0]
        assert agent["id"] == "codex-default"
        assert agent["backend"] == "codex"


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
        """portrait_cache에 없으면 soul-server HTTP 프록시 호출 — 연결 불가 시 204.

        구버전은 404를 반환했으나, 콘솔 노이즈 감소를 위해 204 No Content로 마스킹.
        클라이언트(ProfileAvatar)는 onError + onLoad+naturalWidth 가드로 fallback emoji 표시.
        """
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 9999,
        })

        resp = await client.get("/api/nodes/n1/agents/agent-1/portrait")

        # 9999 포트에 서버 없음 → 연결 실패 → 204
        assert resp.status_code == 204


class TestUserPortraitProxy:
    """사용자 portrait 프록시 테스트."""

    async def test_user_portrait_b64_cache_hit_returns_bytes(self, client, node_manager):
        """user_info에 portrait_b64가 있으면 HTTP 없이 바로 반환한다."""
        import base64

        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 9999,
        })
        portrait_bytes = b"\x89PNGfakeuserportrait"
        portrait_b64 = base64.b64encode(portrait_bytes).decode("ascii")
        node.set_user_info({"name": "유저", "hasPortrait": True, "portrait_b64": portrait_b64})

        resp = await client.get("/api/nodes/n1/user/portrait")

        assert resp.status_code == 200
        assert resp.content == portrait_bytes
        assert resp.headers["content-type"].startswith("image/png")

    async def test_user_portrait_b64_cache_miss_proxies_http(self, client, node_manager):
        """portrait_b64 없으면 soul-server HTTP 프록시 호출 — 연결 불가 시 204."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        node = await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 9999,
        })
        # portrait_b64 없는 user_info
        node.set_user_info({"name": "유저", "hasPortrait": True})

        resp = await client.get("/api/nodes/n1/user/portrait")

        # 9999 포트에 서버 없음 → 연결 실패 → 204 (콘솔 노이즈 마스킹)
        assert resp.status_code == 204

    async def test_user_portrait_proxies_http(self, client, node_manager):
        """user portrait 요청 시 soul-server HTTP 프록시 호출 — 연결 불가 시 204."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 9999,
        })

        resp = await client.get("/api/nodes/n1/user/portrait")

        # 9999 포트에 서버 없음 → 연결 실패 → 204
        assert resp.status_code == 204

    async def test_user_portrait_204_for_unknown_node(self, client):
        """알 수 없는 node_id에 대해 204를 반환한다 (콘솔 노이즈 마스킹).

        구버전은 404를 반환했다. 미연결 노드(eias-linegames 등)의 portrait 요청이
        매번 빨간 콘솔 에러를 발생시키던 문제를 해소.
        """
        resp = await client.get("/api/nodes/unknown-node/user/portrait")

        assert resp.status_code == 204

    async def test_agent_portrait_204_for_unknown_node(self, client):
        """agent/portrait도 알 수 없는 node_id에 204 (대칭성)."""
        resp = await client.get("/api/nodes/unknown-node/agents/agent-x/portrait")

        assert resp.status_code == 204

    async def test_user_portrait_remote_404_masked_to_204(self, client, node_manager):
        """원격 soul-server가 404를 반환해도 클라이언트는 204를 받는다."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 4100,
        })

        # httpx mock으로 404 응답
        from unittest.mock import patch

        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.content = b""

        with patch("soulstream_server.api.nodes.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/nodes/n1/user/portrait")

        assert resp.status_code == 204

    async def test_user_portrait_remote_500_passes_through(self, client, node_manager):
        """원격 soul-server 5xx는 그대로 전파 (운영 의미가 있음 — 마스킹 금지)."""
        ws = AsyncMock()
        ws.send_json = AsyncMock()
        ws.close = AsyncMock()
        await node_manager.register_node(ws, {
            "node_id": "n1", "host": "localhost", "port": 4100,
        })

        from unittest.mock import patch

        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.content = b'{"error": "internal"}'

        with patch("soulstream_server.api.nodes.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/nodes/n1/user/portrait")

        assert resp.status_code == 500
