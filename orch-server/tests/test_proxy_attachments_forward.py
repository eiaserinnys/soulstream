"""orch-server attachments 프록시 헤더 forward 테스트.

api/attachments.py의 2개 프록시 핸들러:
- proxy_upload  (POST   /api/attachments/sessions)
- proxy_delete  (DELETE /api/attachments/sessions/{session_id})

각 호출이 들어온 요청의 Authorization 헤더를 forward하는지 검증한다.
test_api_attachments.py는 respx.mock으로 비즈니스 동작을 검증하므로,
본 파일은 patch("...httpx.AsyncClient") 패턴으로 헤더 forward 검증만 담당한다.
검증 책임이 분리되어 있어 mock 패턴이 다르더라도 충돌 없음 (정본은 하나).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import io
import pytest

from tests.conftest import TEST_AUTH_TOKEN


pytestmark = pytest.mark.asyncio


def _make_response(status_code: int, json_body: dict) -> MagicMock:
    """httpx.Response의 부분 mock."""
    import json as _json

    resp = MagicMock()
    resp.status_code = status_code
    resp.content = _json.dumps(json_body).encode("utf-8")
    resp.headers = {"content-type": "application/json"}
    resp.json = MagicMock(return_value=json_body)
    resp.raise_for_status = MagicMock(return_value=None)
    return resp


async def _register_node(node_manager, node_id: str = "test-node", host: str = "localhost", port: int = 4100):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return await node_manager.register_node(ws, {"node_id": node_id, "host": host, "port": port})


class TestAttachmentUploadProxy:
    """`POST /api/attachments/sessions` 프록시."""

    async def test_forwards_auth_header(self, client, node_manager):
        node = await _register_node(node_manager)
        mock_resp = _make_response(201, {"file_id": "f-1", "url": "..."})

        with patch("soulstream_server.api.attachments.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            file_data = ("test.txt", io.BytesIO(b"hello"), "text/plain")
            resp = await client.post(
                f"/api/attachments/sessions?nodeId={node.node_id}",
                files={"file": file_data},
                data={"session_id": "sess-1"},
            )

        assert resp.status_code == 201
        called_url, called_kwargs = mock_client.post.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/attachments/sessions"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"


class TestAttachmentDeleteProxy:
    """`DELETE /api/attachments/sessions/{id}` 프록시."""

    async def test_forwards_auth_header(self, client, node_manager):
        node = await _register_node(node_manager)
        mock_resp = _make_response(200, {"deleted": True})

        with patch("soulstream_server.api.attachments.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.delete = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value.__aenter__.return_value = mock_client

            resp = await client.delete(f"/api/attachments/sessions/sess-1?nodeId={node.node_id}")

        assert resp.status_code == 200
        called_url, called_kwargs = mock_client.delete.call_args
        assert called_url[0] == f"http://{node.host}:{node.port}/attachments/sessions/sess-1"
        assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"
