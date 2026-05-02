"""orch-server nodes 프록시 헤더 forward 테스트.

api/nodes.py의 3개 프록시 핸들러:
- proxy_agent_portrait        (GET /api/nodes/{node_id}/agents/{agent_id}/portrait)
- list_node_oauth_profiles    (GET /api/nodes/{node_id}/oauth-profiles)
- proxy_user_portrait         (GET /api/nodes/{node_id}/user/portrait)

각 호출이 들어온 요청의 Authorization 헤더를 forward하는지 검증한다.
test_api_nodes.py가 비즈니스 동작 검증을 담당하므로, 본 파일은 헤더 forward 검증에만 집중한다.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.conftest import TEST_AUTH_TOKEN


pytestmark = pytest.mark.asyncio


def _make_response(status_code: int, content: bytes = b"", content_type: str = "image/png", json_body: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.headers = {"content-type": content_type}
    if json_body is not None:
        resp.json = MagicMock(return_value=json_body)
    return resp


async def _register_node(node_manager, node_id: str = "test-node", host: str = "localhost", port: int = 4100):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return await node_manager.register_node(ws, {"node_id": node_id, "host": host, "port": port})


class TestAgentPortraitProxy:
    """`GET /api/nodes/{id}/agents/{aid}/portrait` 프록시."""

    async def test_forwards_auth_header_when_no_cache(self, client, node_manager):
        """portrait 캐시가 없어 HTTP 폴백 시 헤더 forward 검증."""
        node = await _register_node(node_manager)
        # portrait_cache가 비어있도록 보장 (register_node 직후 default 상태)
        node.portrait_cache.pop("agent-x", None)

        mock_resp = _make_response(200, content=b"\x89PNG\r\n\x1a\nFAKEPNGDATA")

        with patch("soulstream_server.api.nodes.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get(f"/api/nodes/{node.node_id}/agents/agent-x/portrait")

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/agents/agent-x/portrait"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"


class TestNodeOAuthProfilesProxy:
    """`GET /api/nodes/{id}/oauth-profiles` 프록시 — verify_token 보호."""

    async def test_forwards_auth_header(self, client, node_manager):
        node = await _register_node(node_manager)
        mock_resp = _make_response(200, json_body={"profiles": []})

        with patch("soulstream_server.api.nodes.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get(f"/api/nodes/{node.node_id}/oauth-profiles")

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/auth/claude/profiles"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"


class TestUserPortraitProxy:
    """`GET /api/nodes/{id}/user/portrait` 프록시."""

    async def test_forwards_auth_header_when_no_b64_cache(self, client, node_manager):
        """portrait_b64 캐시가 없어 HTTP 폴백 시 헤더 forward 검증."""
        node = await _register_node(node_manager)
        # user_info에 portrait_b64가 없도록 (register_node default)
        node.user_info.pop("portrait_b64", None)

        mock_resp = _make_response(200, content=b"\x89PNG\r\n\x1a\nFAKEPNGDATA")

        with patch("soulstream_server.api.nodes.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get(f"/api/nodes/{node.node_id}/user/portrait")

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/dashboard/portrait/user"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"
