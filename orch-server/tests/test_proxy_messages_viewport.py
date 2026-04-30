"""orch-server `/api/sessions/{id}/events/viewport`, `/{id}/messages` HTTP 프록시 테스트.

이 두 엔드포인트는 soul-server 측 dashboard router(/api 마운트)에만 존재하므로
unified-dashboard에서 same-origin으로 호출 시 orch-server에서 forward해야 한다.

각 케이스는 _find_node + httpx.AsyncClient를 mock하여 검증한다.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest


pytestmark = pytest.mark.asyncio


def _make_response(status_code: int, json_body: dict, content_type: str = "application/json") -> MagicMock:
    """httpx.Response의 부분 mock — content/status/headers만 사용."""
    import json as _json

    resp = MagicMock()
    resp.status_code = status_code
    resp.content = _json.dumps(json_body).encode("utf-8")
    resp.headers = {"content-type": content_type}
    return resp


async def _register_node(node_manager, node_id: str = "test-node", host: str = "localhost", port: int = 4100):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return await node_manager.register_node(ws, {"node_id": node_id, "host": host, "port": port})


class TestViewportProxy:
    """`GET /api/sessions/{id}/events/viewport` 프록시."""

    async def test_proxies_with_node(self, client, mock_db, node_manager):
        """노드가 등록되어 있고 soul-server가 200을 반환하면 body/status를 미러링."""
        node = await _register_node(node_manager)
        mock_db.get_session = AsyncMock(return_value={"session_id": "sess-1", "node_id": node.node_id})

        body = {"events": [{"id": 1, "y_start": 1, "y_end": 5}], "total_subtree_height": 100}
        mock_resp = _make_response(200, body)

        with patch("soulstream_server.api.sessions.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/sessions/sess-1/events/viewport?y_min=1&y_max=50")

        assert resp.status_code == 200
        assert resp.json() == body
        # soul-server URL 검증
        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/sessions/sess-1/events/viewport"
        assert called_kwargs["params"] == {"y_min": 1, "y_max": 50}

    async def test_404_for_unknown_session(self, client, mock_db, node_manager):
        """_find_node가 None이면 404 ('Session not found')."""
        # 노드도 없고 DB도 비어 있음 → _find_node가 HTTPException(404) raise
        mock_db.get_session = AsyncMock(return_value=None)

        resp = await client.get("/api/sessions/sess-unknown/events/viewport?y_min=1&y_max=50")

        assert resp.status_code == 404

    async def test_502_on_request_error(self, client, mock_db, node_manager):
        """soul-server 호출 시 RequestError 발생 → 502."""
        node = await _register_node(node_manager)
        mock_db.get_session = AsyncMock(return_value={"session_id": "sess-1", "node_id": node.node_id})

        with patch("soulstream_server.api.sessions.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=httpx.RequestError("boom"))
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/sessions/sess-1/events/viewport?y_min=1&y_max=50")

        assert resp.status_code == 502


class TestMessagesProxy:
    """`GET /api/sessions/{id}/messages` 프록시."""

    async def test_proxies_with_node(self, client, mock_db, node_manager):
        """노드가 있고 soul-server가 200을 반환하면 body 미러링."""
        node = await _register_node(node_manager)
        mock_db.get_session = AsyncMock(return_value={"session_id": "sess-1", "node_id": node.node_id})

        body = {
            "messages": [{"id": 1, "event_type": "user_message"}],
            "next_cursor": "2026-04-01T00:00:00Z",
        }
        mock_resp = _make_response(200, body)

        with patch("soulstream_server.api.sessions.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/sessions/sess-1/messages?limit=50")

        assert resp.status_code == 200
        assert resp.json() == body

    async def test_passes_query_params(self, client, mock_db, node_manager):
        """before/limit 쿼리가 그대로 soul-server로 전달됨을 검증."""
        node = await _register_node(node_manager)
        mock_db.get_session = AsyncMock(return_value={"session_id": "sess-1", "node_id": node.node_id})

        mock_resp = _make_response(200, {"messages": [], "next_cursor": None})

        with patch("soulstream_server.api.sessions.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            await client.get("/api/sessions/sess-1/messages?limit=25&before=2026-04-01T00:00:00Z")

        called_url, called_kwargs = mock_client.get.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/api/sessions/sess-1/messages"
        assert called_kwargs["params"] == {"limit": 25, "before": "2026-04-01T00:00:00Z"}

    async def test_404_for_unknown_session(self, client, mock_db):
        """세션이 DB에 없으면 404."""
        mock_db.get_session = AsyncMock(return_value=None)

        resp = await client.get("/api/sessions/sess-unknown/messages?limit=50")

        assert resp.status_code == 404

    async def test_502_on_timeout(self, client, mock_db, node_manager):
        """soul-server 호출 시 TimeoutException 발생 → 502."""
        node = await _register_node(node_manager)
        mock_db.get_session = AsyncMock(return_value={"session_id": "sess-1", "node_id": node.node_id})

        with patch("soulstream_server.api.sessions.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("slow"))
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.get("/api/sessions/sess-1/messages?limit=50")

        assert resp.status_code == 502
