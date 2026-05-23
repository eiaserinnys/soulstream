"""orch-server config 프록시 헤더 forward 테스트.

api/config.py의 3개 프록시 핸들러:
- proxy_config_settings_get  (GET  /api/config/settings)
- proxy_config_settings_put  (PUT  /api/config/settings)
- proxy_dashboard_config     (GET  /api/dashboard/config)

각 호출이 들어온 요청의 Authorization 헤더를 forward하는지 검증한다.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from tests.conftest import TEST_AUTH_TOKEN


pytestmark = pytest.mark.asyncio


def _make_response(status_code: int, json_body: dict, content_type: str = "application/json") -> MagicMock:
    """httpx.Response의 부분 mock — content/status/headers만 사용."""
    import json as _json

    resp = MagicMock()
    resp.status_code = status_code
    resp.content = _json.dumps(json_body).encode("utf-8")
    resp.headers = {"content-type": content_type}
    resp.json = MagicMock(return_value=json_body)
    return resp


async def _register_node(
    node_manager,
    node_id: str = "test-node",
    host: str = "localhost",
    port: int = 4100,
):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return await node_manager.register_node(
        ws,
        {
            "node_id": node_id,
            "host": host,
            "port": port,
            "agents": [],
            "user": {"name": "Test User", "id": "test-user", "hasPortrait": False},
        },
    )


class TestConfigSettingsGetProxy:
    """`GET /api/config/settings` 프록시."""

    async def test_forwards_auth_header(self, client, node_manager):
        node = await _register_node(node_manager)
        mock_resp = _make_response(200, {"categories": [{"name": "general", "fields": []}]})

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/config/settings")

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/config/settings"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"

    async def test_returns_empty_categories_when_no_node(self, client):
        """노드 미연결 시 forward 없이 기본값 반환 (현재 동작 유지)."""
        resp = await client.get("/api/config/settings")
        assert resp.status_code == 200
        assert resp.json() == {"categories": []}

    async def test_skips_first_404_node_and_uses_second_200(self, client, node_manager):
        node_a = await _register_node(node_manager, "node-a", port=4100)
        node_b = await _register_node(node_manager, "node-b", port=4101)
        first_resp = _make_response(404, {"detail": "not found"})
        second_body = {"categories": [{"name": "runtime", "fields": []}]}
        second_resp = _make_response(200, second_body)

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=[first_resp, second_resp])
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/config/settings")

        assert resp.status_code == 200
        assert resp.json() == second_body
        assert [call.args[0] for call in mock_client.get.call_args_list] == [
            f"http://{node_a.host}:{node_a.port}/api/config/settings",
            f"http://{node_b.host}:{node_b.port}/api/config/settings",
        ]

    async def test_returns_empty_categories_when_all_nodes_fail(self, client, node_manager):
        await _register_node(node_manager, "node-a", port=4100)
        await _register_node(node_manager, "node-b", port=4101)

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(
                side_effect=[
                    _make_response(404, {"detail": "not found"}),
                    httpx.ConnectError("connection failed"),
                ]
            )
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/config/settings")

        assert resp.status_code == 200
        assert resp.json() == {"categories": []}


class TestConfigSettingsPutProxy:
    """`PUT /api/config/settings` 프록시."""

    async def test_forwards_auth_header(self, client, node_manager):
        node = await _register_node(node_manager)
        mock_resp = _make_response(200, {"applied": ["KEY"]})

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.put = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.put("/api/config/settings", json={"changes": {"KEY": "value"}})

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.put.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/config/settings"
        assert called_kwargs["json"] == {"changes": {"KEY": "value"}}
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"

    async def test_skips_first_404_node_and_uses_second_200(self, client, node_manager):
        node_a = await _register_node(node_manager, "node-a", port=4100)
        node_b = await _register_node(node_manager, "node-b", port=4101)
        body = {"changes": {"KEY": "value"}}
        mock_resp = _make_response(200, {"applied": ["KEY"]})

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.put = AsyncMock(
                side_effect=[
                    _make_response(404, {"detail": "not found"}),
                    mock_resp,
                ]
            )
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.put("/api/config/settings", json=body)

        assert resp.status_code == 200
        assert resp.json() == {"applied": ["KEY"]}
        assert [call.args[0] for call in mock_client.put.call_args_list] == [
            f"http://{node_a.host}:{node_a.port}/api/config/settings",
            f"http://{node_b.host}:{node_b.port}/api/config/settings",
        ]
        assert all(call.kwargs["json"] == body for call in mock_client.put.call_args_list)

    async def test_returns_503_when_all_nodes_fail(self, client, node_manager):
        await _register_node(node_manager, "node-a", port=4100)
        await _register_node(node_manager, "node-b", port=4101)

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.put = AsyncMock(
                side_effect=[
                    _make_response(404, {"detail": "not found"}),
                    httpx.ConnectError("connection failed"),
                ]
            )
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.put("/api/config/settings", json={"changes": {"KEY": "value"}})

        assert resp.status_code == 503


class TestDashboardConfigProxy:
    """`GET /api/dashboard/config` 프록시."""

    async def test_forwards_auth_header(self, client, node_manager):
        node = await _register_node(node_manager)
        body = {"user": {"name": "U", "id": "u", "hasPortrait": False}, "agents": []}
        mock_resp = _make_response(200, body)

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/dashboard/config")

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/dashboard/config"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"

    async def test_returns_default_when_no_node(self, client):
        """노드 미연결 시 forward 없이 기본 dashboard config 반환."""
        resp = await client.get("/api/dashboard/config")
        assert resp.status_code == 200
        data = resp.json()
        assert "user" in data
        assert "agents" in data

    async def test_skips_first_404_node_and_uses_second_200(self, client, node_manager):
        node_a = await _register_node(node_manager, "node-a", port=4100)
        node_b = await _register_node(node_manager, "node-b", port=4101)
        body = {"user": {"name": "U", "id": "u", "hasPortrait": True}, "agents": []}
        first_resp = _make_response(404, {"detail": "not found"})
        second_resp = _make_response(200, body)

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=[first_resp, second_resp])
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/dashboard/config")

        assert resp.status_code == 200
        assert resp.json()["user"]["portraitUrl"] == f"/api/nodes/{node_b.node_id}/user/portrait"
        assert [call.args[0] for call in mock_client.get.call_args_list] == [
            f"http://{node_a.host}:{node_a.port}/api/dashboard/config",
            f"http://{node_b.host}:{node_b.port}/api/dashboard/config",
        ]

    async def test_returns_default_when_all_nodes_fail(self, client, node_manager):
        await _register_node(node_manager, "node-a", port=4100)
        await _register_node(node_manager, "node-b", port=4101)

        with patch("soulstream_server.api.config.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(
                side_effect=[
                    _make_response(405, {"detail": "method not allowed"}),
                    httpx.ConnectError("connection failed"),
                ]
            )
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/dashboard/config")

        assert resp.status_code == 200
        assert resp.json() == {"user": {"name": "User", "id": "", "hasPortrait": False}, "agents": []}
