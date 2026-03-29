"""Common test fixtures for soulstream-server tests."""

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch


def pytest_configure(config):
    """Set required environment variables for Settings validation."""
    defaults = {
        "HOST": "0.0.0.0",
        "PORT": "5200",
        "DATABASE_URL": "postgresql://test:test@localhost:5432/test",
        "ENVIRONMENT": "test",
    }
    for key, value in defaults.items():
        if key not in os.environ:
            os.environ[key] = value

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter


@pytest.fixture
def mock_db():
    """Mock PostgresSessionDB with async methods."""
    db = MagicMock()
    db.get_all_sessions = AsyncMock(return_value=([], 0))
    db.read_events = AsyncMock(return_value=[])
    db.assign_session_to_folder = AsyncMock()
    db.get_all_folders = AsyncMock(return_value=[])
    db.create_folder = AsyncMock()
    db.update_folder = AsyncMock()
    db.delete_folder = AsyncMock()
    db.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return db


@pytest.fixture
def mock_ws():
    """Mock FastAPI WebSocket."""
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    ws.accept = AsyncMock()
    ws.receive_text = AsyncMock()
    return ws


@pytest.fixture
def mock_node_connection(mock_ws):
    """A NodeConnection with a mock WebSocket."""
    return NodeConnection(
        ws=mock_ws,
        node_id="test-node-1",
        host="localhost",
        port=4100,
        capabilities=["session"],
    )


@pytest.fixture
def node_manager():
    """A real NodeManager instance."""
    return NodeManager()


@pytest.fixture
def session_router(node_manager):
    """SessionRouter with a real NodeManager."""
    return SessionRouter(node_manager)


@pytest.fixture
def mock_catalog_service():
    """Mock CatalogService with async methods."""
    cs = MagicMock()
    cs.list_folders = AsyncMock(return_value=[])
    cs.create_folder = AsyncMock(return_value={"id": "f1", "name": "Test", "sortOrder": 0})
    cs.rename_folder = AsyncMock()
    cs.update_folder = AsyncMock()
    cs.delete_folder = AsyncMock()
    cs.reorder_folders = AsyncMock()
    cs.broadcast_catalog = AsyncMock()
    cs.move_sessions_to_folder = AsyncMock()
    cs.rename_session = AsyncMock()
    cs.delete_session = AsyncMock()
    cs.get_catalog = AsyncMock(return_value={"folders": [], "sessions": {}})
    return cs


@pytest.fixture
def broadcaster():
    """A real SessionBroadcaster instance."""
    return SessionBroadcaster()


@pytest.fixture
def test_app(mock_db, node_manager, session_router, mock_catalog_service, broadcaster):
    """FastAPI test app with all routers mounted."""
    from soulstream_server.api.catalog import create_catalog_router
    from soulstream_server.api.folders import create_folders_router
    from soulstream_server.api.nodes import create_nodes_router
    from soulstream_server.api.sessions import create_sessions_router

    app = FastAPI()
    app.include_router(create_sessions_router(mock_db, node_manager, session_router, broadcaster, mock_catalog_service))
    app.include_router(create_nodes_router(node_manager, broadcaster))
    app.include_router(create_folders_router(mock_catalog_service))
    app.include_router(create_catalog_router(mock_catalog_service, mock_db, node_manager))
    return app


@pytest.fixture
async def client(test_app):
    """Async HTTP client for test app."""
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
