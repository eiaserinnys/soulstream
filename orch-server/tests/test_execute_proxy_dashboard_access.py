"""Dashboard folder access tests for POST /api/execute."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from soul_common.auth.jwt import COOKIE_NAME, generate_token
from tests.conftest import TEST_AUTH_TOKEN


JWT_SECRET = "test-jwt-secret-for-execute-proxy-access-32b"
ACCESS_ENV = (
    '{"restricted@example.com":'
    '{"restricted":true,"allowedFolderIds":["allowed-root"]}}'
)


def _folders() -> list[dict]:
    return [
        {"id": "allowed-root", "name": "Allowed", "sortOrder": 0, "parentFolderId": None},
        {"id": "blocked-root", "name": "Blocked", "sortOrder": 1, "parentFolderId": None},
    ]


def _blocked_session(session_id: str = "blocked-sess") -> dict:
    return {
        "session_id": session_id,
        "node_id": "test-node-1",
        "folder_id": "blocked-root",
    }


@pytest.fixture
def mock_db():
    db = MagicMock()
    db.get_all_folders = AsyncMock(return_value=_folders())
    db.get_session = AsyncMock(return_value=None)
    return db


@pytest.fixture
def mock_node():
    node = MagicMock()
    node.node_id = "test-node-1"
    node.send_subscribe_events = AsyncMock(return_value="sub-access")
    node.send_intervene = AsyncMock(return_value={"ok": True})
    node.unsubscribe_events = MagicMock()
    return node


@pytest.fixture
def mock_node_manager(mock_node):
    nm = MagicMock()
    nm.get_node = MagicMock(return_value=mock_node)
    nm.get_connected_nodes = MagicMock(return_value=[mock_node])
    nm.find_node_for_session = MagicMock(return_value=mock_node)
    return nm


@pytest.fixture
def mock_session_router():
    router = MagicMock()
    router.route_create_session = AsyncMock(return_value=("sess-123", "test-node-1"))
    return router


@pytest.fixture
def mock_catalog_service():
    cs = MagicMock()
    cs.broadcast_catalog = AsyncMock()
    cs.list_folders = AsyncMock(return_value=_folders())
    return cs


@pytest.fixture
def secure_exec_app(
    monkeypatch,
    mock_db,
    mock_node_manager,
    mock_session_router,
    mock_catalog_service,
):
    from soulstream_server.config import get_settings
    from soulstream_server.main import create_app
    from soulstream_server.service.session_broadcaster import SessionBroadcaster
    from soulstream_server.users import DashboardUserService

    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ALLOWED_EMAIL", "owner@example.com")
    monkeypatch.setenv("DASHBOARD_USER_FOLDER_ACCESS", ACCESS_ENV)
    get_settings.cache_clear()

    user_service = DashboardUserService.memory_from_settings(get_settings())
    app = create_app(
        db=mock_db,
        node_manager=mock_node_manager,
        session_router=mock_session_router,
        broadcaster=SessionBroadcaster(),
        catalog_service=mock_catalog_service,
        user_service=user_service,
    )
    yield app
    get_settings.cache_clear()


@pytest.fixture
async def secure_service_client(secure_exec_app):
    transport = ASGITransport(app=secure_exec_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {TEST_AUTH_TOKEN}"},
    ) as client:
        yield client


@pytest.fixture
async def secure_restricted_client(secure_exec_app):
    token = generate_token(
        {"email": "restricted@example.com", "name": "Restricted"},
        JWT_SECRET,
    )
    transport = ASGITransport(app=secure_exec_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: token},
    ) as client:
        yield client


@pytest.fixture
async def secure_admin_client(secure_exec_app):
    token = generate_token(
        {"email": "owner@example.com", "name": "Owner"},
        JWT_SECRET,
    )
    transport = ASGITransport(app=secure_exec_app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: token},
    ) as client:
        yield client


def _complete_stream(mock_node):
    async def fake_subscribe(session_id, callback):
        async def emit():
            await asyncio.sleep(0.01)
            await callback({"event": {"type": "complete", "_event_id": 1}})
        asyncio.create_task(emit())
        return "sub-access"

    mock_node.send_subscribe_events = AsyncMock(side_effect=fake_subscribe)


class TestExecuteProxyDashboardAccess:
    async def test_new_service_token_uses_body_caller_email_for_folder_access(
        self, secure_service_client, mock_session_router, mock_node
    ):
        _complete_stream(mock_node)

        resp = await secure_service_client.post("/api/execute", json={
            "prompt": "delegate",
            "profile": "test-agent",
            "folder_id": "blocked-root",
            "caller_info": {"source": "agent", "email": "owner@example.com"},
        })

        assert resp.status_code == 200, resp.text
        mock_session_router.route_create_session.assert_awaited_once()
        payload = mock_session_router.route_create_session.await_args.args[0]
        assert payload["folderId"] == "blocked-root"

    async def test_new_jwt_restricted_user_cannot_spoof_body_caller_email(
        self, secure_restricted_client, mock_session_router, mock_node
    ):
        _complete_stream(mock_node)

        resp = await secure_restricted_client.post("/api/execute", json={
            "prompt": "blocked",
            "profile": "test-agent",
            "folder_id": "blocked-root",
            "caller_info": {"source": "agent", "email": "owner@example.com"},
        })

        assert resp.status_code == 403
        mock_session_router.route_create_session.assert_not_awaited()

    async def test_new_jwt_admin_path_regression(
        self, secure_admin_client, mock_session_router, mock_node
    ):
        _complete_stream(mock_node)

        resp = await secure_admin_client.post("/api/execute", json={
            "prompt": "admin",
            "profile": "test-agent",
            "folder_id": "blocked-root",
        })

        assert resp.status_code == 200, resp.text
        mock_session_router.route_create_session.assert_awaited_once()

    async def test_resume_service_token_uses_body_caller_email_for_session_access(
        self, secure_service_client, mock_db, mock_node
    ):
        mock_db.get_session = AsyncMock(return_value=_blocked_session())
        _complete_stream(mock_node)

        resp = await secure_service_client.post("/api/execute", json={
            "prompt": "continue",
            "agent_session_id": "blocked-sess",
            "caller_info": {"source": "agent", "email": "owner@example.com"},
        })

        assert resp.status_code == 200, resp.text
        mock_node.send_intervene.assert_awaited_once()

    async def test_resume_jwt_restricted_user_cannot_spoof_body_caller_email(
        self, secure_restricted_client, mock_db, mock_node
    ):
        mock_db.get_session = AsyncMock(return_value=_blocked_session())
        _complete_stream(mock_node)

        resp = await secure_restricted_client.post("/api/execute", json={
            "prompt": "blocked",
            "agent_session_id": "blocked-sess",
            "caller_info": {"source": "agent", "email": "owner@example.com"},
        })

        assert resp.status_code == 403
        mock_node.send_intervene.assert_not_awaited()

    async def test_resume_jwt_admin_path_regression(
        self, secure_admin_client, mock_db, mock_node
    ):
        mock_db.get_session = AsyncMock(return_value=_blocked_session())
        _complete_stream(mock_node)

        resp = await secure_admin_client.post("/api/execute", json={
            "prompt": "admin continue",
            "agent_session_id": "blocked-sess",
        })

        assert resp.status_code == 200, resp.text
        mock_node.send_intervene.assert_awaited_once()
