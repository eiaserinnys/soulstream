"""orch-server cogito 프록시 헤더 forward 테스트.

api/cogito.py의 search 핸들러는 연결된 모든 노드에 fan-out한다.
각 fan-out 호출에 들어온 요청의 Authorization 헤더가 forward되는지 검증한다.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.conftest import TEST_AUTH_TOKEN


pytestmark = pytest.mark.asyncio


def _make_response(status_code: int, json_body: dict) -> MagicMock:
    import json as _json

    resp = MagicMock()
    resp.status_code = status_code
    resp.content = _json.dumps(json_body).encode("utf-8")
    resp.headers = {"content-type": "application/json"}
    resp.json = MagicMock(return_value=json_body)
    return resp


async def _register_node(node_manager, node_id: str, host: str = "localhost", port: int = 4100):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return await node_manager.register_node(ws, {"node_id": node_id, "host": host, "port": port})


class TestCogitoSearchProxy:
    """`GET /cogito/search` fan-out 프록시."""

    async def test_forwards_auth_header_to_all_nodes(self, client, node_manager):
        """fan-out한 모든 노드 호출에 Authorization 헤더가 포함되어야 한다."""
        node1 = await _register_node(node_manager, "node-a", port=4100)
        node2 = await _register_node(node_manager, "node-b", port=4101)

        mock_resp = _make_response(200, {"results": []})

        with patch("soulstream_server.api.cogito.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/cogito/search?q=hello&top_k=5")

        assert resp.status_code == 200
        # 두 노드에 fan-out → mock_client.get 두 번 호출
        assert mock_client.get.call_count == 2
        # 각 호출이 동일한 forward header dict를 사용
        for call in mock_client.get.call_args_list:
            _, kwargs = call
            assert kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"

    async def test_returns_empty_when_no_nodes(self, client):
        """노드 미연결 시 forward 없이 빈 결과 반환."""
        resp = await client.get("/cogito/search?q=x")
        assert resp.status_code == 200
        assert resp.json() == {"results": []}
