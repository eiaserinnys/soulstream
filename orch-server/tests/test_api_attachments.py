"""Tests for Attachments proxy API (/api/attachments)."""

import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager


def make_test_app(node_manager: NodeManager) -> FastAPI:
    """attachments 라우터만 마운트한 테스트 앱."""
    from soulstream_server.api.attachments import create_attachments_router

    app = FastAPI()
    app.include_router(create_attachments_router(node_manager))
    return app


@pytest.fixture
def mock_ws_for_attachments():
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    ws.accept = AsyncMock()
    return ws


@pytest.fixture
def populated_node_manager(mock_ws_for_attachments):
    """'node-1' 노드가 등록된 NodeManager."""
    nm = NodeManager()
    conn = NodeConnection(
        ws=mock_ws_for_attachments,
        node_id="node-1",
        host="localhost",
        port=4100,
    )
    nm._nodes["node-1"] = conn
    return nm


@pytest.fixture
def empty_node_manager():
    return NodeManager()


@pytest.fixture
async def attachments_client(populated_node_manager):
    app = make_test_app(populated_node_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def empty_attachments_client(empty_node_manager):
    app = make_test_app(empty_node_manager)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestProxyUpload:
    """POST /api/attachments/sessions 테스트."""

    async def test_proxies_to_soul_server(self, attachments_client, populated_node_manager):
        """등록된 노드가 있을 때 soul-server로 파일을 프록시한다."""
        import respx
        import httpx

        soul_response = {"path": "/incoming/session-abc/test.txt"}

        with respx.mock:
            respx.post("http://localhost:4100/attachments/sessions").mock(
                return_value=httpx.Response(201, json=soul_response)
            )

            resp = await attachments_client.post(
                "/api/attachments/sessions?nodeId=node-1",
                data={"session_id": "session-abc"},
                files={"file": ("test.txt", b"hello world", "text/plain")},
            )

        assert resp.status_code == 201
        assert resp.json() == soul_response

    async def test_returns_404_for_unknown_node(self, attachments_client):
        """미등록 노드 ID 요청 시 404를 반환한다."""
        resp = await attachments_client.post(
            "/api/attachments/sessions?nodeId=unknown-node",
            data={"session_id": "session-abc"},
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
        assert resp.status_code == 404

    async def test_returns_404_when_no_nodeid(self, attachments_client):
        """nodeId 파라미터가 없으면 422(validation error)를 반환한다."""
        resp = await attachments_client.post(
            "/api/attachments/sessions",
            data={"session_id": "session-abc"},
            files={"file": ("test.txt", b"hello", "text/plain")},
        )
        # nodeId는 required Query param이므로 FastAPI가 422 반환
        assert resp.status_code == 422


class TestProxyDelete:
    """DELETE /api/attachments/sessions/{session_id} 테스트."""

    async def test_proxies_delete_to_soul_server(self, attachments_client):
        """등록된 노드가 있을 때 soul-server로 DELETE를 프록시한다."""
        import respx
        import httpx

        soul_response = {"deleted": 2}

        with respx.mock:
            respx.delete("http://localhost:4100/attachments/sessions/session-abc").mock(
                return_value=httpx.Response(200, json=soul_response)
            )

            resp = await attachments_client.delete(
                "/api/attachments/sessions/session-abc?nodeId=node-1"
            )

        assert resp.status_code == 200
        assert resp.json() == soul_response

    async def test_delete_returns_404_for_unknown_node(self, attachments_client):
        """미등록 노드 ID로 DELETE 요청 시 404를 반환한다."""
        resp = await attachments_client.delete(
            "/api/attachments/sessions/session-abc?nodeId=no-such-node"
        )
        assert resp.status_code == 404
