from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soulstream_server.api.provider_usage import create_provider_usage_router
from soulstream_server.nodes.node_manager import NodeManager


@pytest.fixture
def node_manager():
    return NodeManager()


@pytest.fixture
def test_app(node_manager):
    app = FastAPI()
    app.include_router(create_provider_usage_router(node_manager))
    return app


@pytest.fixture
async def client(test_app):
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def _register_node(node_manager, node_id="test-node"):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    await node_manager.register_node(ws, {
        "node_id": node_id,
        "host": "localhost",
        "port": 4100,
    })
    return node_id


async def test_provider_usage_returns_node_data(client, node_manager):
    node_id = await _register_node(node_manager)
    conn = node_manager.get_node(node_id)
    conn.send_provider_usage_get = AsyncMock(return_value={
        "success": True,
        "data": {
            "generatedAt": "2026-05-23T00:00:00Z",
            "providers": {},
        },
    })

    resp = await client.get(f"/api/nodes/{node_id}/provider-usage")

    assert resp.status_code == 200
    assert resp.json()["providers"] == {}
    conn.send_provider_usage_get.assert_called_once_with()


async def test_provider_usage_one_validates_provider(client, node_manager):
    node_id = await _register_node(node_manager)
    conn = node_manager.get_node(node_id)
    conn.send_provider_usage_get = AsyncMock(return_value={
        "success": True,
        "data": {"status": "not_configured", "quotas": []},
    })

    resp = await client.get(f"/api/nodes/{node_id}/provider-usage/codex")

    assert resp.status_code == 200
    conn.send_provider_usage_get.assert_called_once_with("codex")


async def test_provider_usage_rejects_unknown_provider(client, node_manager):
    node_id = await _register_node(node_manager)

    resp = await client.get(f"/api/nodes/{node_id}/provider-usage/unknown")

    assert resp.status_code == 400
    assert "provider must be one of" in resp.json()["detail"]
