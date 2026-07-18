"""Restricted dashboard folder access tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from soul_common.auth.jwt import COOKIE_NAME, generate_token
from soulstream_server.config import get_settings
from soulstream_server.dashboard_access import access_for_request
from soulstream_server.main import create_app
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter
from tests.conftest import TEST_AUTH_TOKEN
from soulstream_server.users import DashboardUserService


JWT_SECRET = "test-jwt-secret-for-dashboard-access-32b"
ACCESS_ENV = (
    '{"bellon.lovedive@gmail.com":'
    '{"restricted":true,"allowedFolderIds":["allowed-root"]}}'
)
DEFAULT_AGENT_REGISTRATION = {
    "agents": [
        {
            "id": "default-agent",
            "name": "Default Agent",
            "backend": "claude",
        }
    ]
}


def _session(session_id: str, folder_id: str) -> dict:
    return {
        "session_id": session_id,
        "node_id": "node-1",
        "agent_id": None,
        "status": "running",
        "session_type": "claude",
        "created_at": "2026-06-06T00:00:00",
        "updated_at": "2026-06-06T00:00:00",
        "last_event_id": 0,
        "last_read_event_id": 0,
        "prompt": "hello",
        "last_message": None,
        "metadata": [],
        "folder_id": folder_id,
    }


def _folders() -> list[dict]:
    return [
        {"id": "allowed-root", "name": "Allowed", "sortOrder": 0, "parentFolderId": None},
        {"id": "allowed-child", "name": "Child", "sortOrder": 0, "parentFolderId": "allowed-root"},
        {"id": "allowed-grandchild", "name": "Grand", "sortOrder": 0, "parentFolderId": "allowed-child"},
        {"id": "blocked-root", "name": "Blocked", "sortOrder": 1, "parentFolderId": None},
    ]


def _build_app(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ALLOWED_EMAIL", "owner@example.com")
    monkeypatch.setenv("DASHBOARD_USER_FOLDER_ACCESS", ACCESS_ENV)
    get_settings.cache_clear()

    db = MagicMock()
    db.get_all_sessions = AsyncMock(return_value=([_session("s-allowed", "allowed-child")], 1))
    db.get_session = AsyncMock(return_value=_session("s-allowed", "allowed-child"))
    db.get_all_folders = AsyncMock(return_value=_folders())
    db.read_events = AsyncMock(return_value=[])
    db.read_messages = AsyncMock(return_value=([], None))
    db.read_timeline = AsyncMock(return_value=([], None))
    db.read_viewport = AsyncMock(return_value={"events": []})
    db.get_folder_counts = AsyncMock(return_value={
        "allowed-root": 1,
        "allowed-child": 2,
        "blocked-root": 9,
    })

    catalog_service = MagicMock()
    catalog_service.list_folders = AsyncMock(return_value=_folders())
    catalog_service.list_session_assignments = AsyncMock(return_value={
        "s-allowed": {"folderId": "allowed-child", "displayName": None},
        "s-blocked": {"folderId": "blocked-root", "displayName": None},
    })
    catalog_service.list_board_items = AsyncMock(return_value=[{
        "id": "item-1",
        "folderId": "allowed-child",
        "itemType": "session",
        "itemId": "s-allowed",
        "x": 0,
        "y": 0,
    }])
    catalog_service.get_catalog = AsyncMock(return_value={
        "folders": _folders(),
        "sessions": {},
        "boardItems": [{
            "id": "blocked-item",
            "folderId": "blocked-root",
            "itemType": "session",
            "itemId": "s-blocked",
            "x": 0,
            "y": 0,
        }],
    })
    catalog_service.broadcast_catalog = AsyncMock()
    catalog_service.update_board_item_position = AsyncMock()
    catalog_service.move_sessions_to_folder = AsyncMock()

    node_manager = NodeManager()
    broadcaster = SessionBroadcaster()
    user_service = DashboardUserService.memory_from_settings(get_settings())
    app = create_app(
        db=db,
        node_manager=node_manager,
        session_router=SessionRouter(node_manager),
        broadcaster=broadcaster,
        catalog_service=catalog_service,
        user_service=user_service,
    )
    return app, db, catalog_service, node_manager


async def _register_node(node_manager: NodeManager):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    node = await node_manager.register_node(
        ws,
        {"node_id": "node-1", **DEFAULT_AGENT_REGISTRATION},
    )

    async def resolve_on_send(data):
        req_id = data.get("requestId")
        if req_id and req_id in node._pending:
            if data.get("type") == "intervene":
                node._pending[req_id].set_result({"status": "queued"})
            else:
                node._pending[req_id].set_result({"agentSessionId": "sess-routed"})

    ws.send_json.side_effect = resolve_on_send
    return node, ws


def _access_request(
    app,
    *,
    auth_user: dict | None = None,
    auth_mode: str | None = None,
    cookie: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if cookie is not None:
        headers.append((b"cookie", cookie.encode()))
    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": headers,
        "app": app,
    })
    if auth_user is not None:
        request.state.auth_user = auth_user
    if auth_mode is not None:
        request.state.auth_mode = auth_mode
    return request


async def _restricted_client(app):
    token = generate_token(
        {"email": "bellon.lovedive@gmail.com", "name": "Bellon"},
        JWT_SECRET,
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: token},
    ) as client:
        yield client


async def _admin_client(app):
    token = generate_token(
        {"email": "owner@example.com", "name": "Owner"},
        JWT_SECRET,
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: token},
    ) as client:
        yield client


async def _service_token_client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {TEST_AUTH_TOKEN}"},
    ) as client:
        yield client


def test_access_for_request_service_token_with_admin_access_email_has_full_access(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    request = _access_request(app, auth_mode="service_token")

    access = access_for_request(request, access_email="owner@example.com")

    assert access.restricted is False


def test_access_for_request_service_token_with_restricted_access_email_uses_user_rule(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    request = _access_request(app, auth_mode="service_token")

    access = access_for_request(request, access_email="bellon.lovedive@gmail.com")

    assert access.restricted is True
    assert access.allowed_folder_ids == ("allowed-root",)


def test_access_for_request_jwt_restricted_user_ignores_spoofed_access_email(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    request = _access_request(
        app,
        auth_mode="jwt",
        auth_user={"email": "bellon.lovedive@gmail.com", "name": "Bellon"},
    )

    access = access_for_request(request, access_email="owner@example.com")

    assert access.restricted is True
    assert access.allowed_folder_ids == ("allowed-root",)


def test_access_for_request_jwt_cookie_wins_over_service_token_access_email(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    token = generate_token(
        {"email": "bellon.lovedive@gmail.com", "name": "Bellon"},
        JWT_SECRET,
    )
    request = _access_request(
        app,
        auth_mode="service_token",
        cookie=f"{COOKIE_NAME}={token}",
    )

    access = access_for_request(request, access_email="owner@example.com")

    assert access.restricted is True
    assert access.allowed_folder_ids == ("allowed-root",)


def test_access_for_request_service_token_without_email_has_full_access(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    request = _access_request(app, auth_mode="service_token")

    access = access_for_request(request, access_email=None)

    assert access.restricted is False
    assert access.allowed_folder_ids == ()


def test_access_for_request_jwt_admin_path_regression(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    request = _access_request(
        app,
        auth_mode="jwt",
        auth_user={"email": "owner@example.com", "name": "Owner"},
    )

    access = access_for_request(request)

    assert access.restricted is False


@pytest.mark.asyncio
async def test_auth_status_includes_restricted_dashboard_access(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    async for client in _restricted_client(app):
        resp = await client.get("/api/auth/status")

    assert resp.status_code == 200
    body = resp.json()
    assert body["authenticated"] is True
    assert body["user"]["email"] == "bellon.lovedive@gmail.com"
    assert body["user"]["dashboardAccess"] == {
        "restricted": True,
        "allowedFolderIds": ["allowed-root"],
    }


@pytest.mark.asyncio
async def test_restricted_user_sees_allowed_folder_subtree_only(monkeypatch):
    app, _db, _catalog_service, _node_manager = _build_app(monkeypatch)
    async for client in _restricted_client(app):
        resp = await client.get("/api/folders")

    assert resp.status_code == 200
    body = resp.json()
    assert [folder["id"] for folder in body["folders"]] == [
        "allowed-root",
        "allowed-child",
        "allowed-grandchild",
    ]
    assert body["sessions"] == {
        "s-allowed": {"folderId": "allowed-child", "displayName": None},
    }


@pytest.mark.asyncio
async def test_restricted_user_cannot_query_blocked_folder_sessions(monkeypatch):
    app, db, _catalog_service, _node_manager = _build_app(monkeypatch)
    async for client in _restricted_client(app):
        resp = await client.get("/api/sessions?folder_id=blocked-root")

    assert resp.status_code == 403
    db.get_all_sessions.assert_not_called()


@pytest.mark.asyncio
async def test_restricted_user_can_query_allowed_child_sessions(monkeypatch):
    app, db, _catalog_service, _node_manager = _build_app(monkeypatch)
    async for client in _restricted_client(app):
        resp = await client.get("/api/sessions?folder_id=allowed-child")

    assert resp.status_code == 200
    db.get_all_sessions.assert_awaited_once()
    assert db.get_all_sessions.await_args.kwargs["folder_id"] == "allowed-child"


@pytest.mark.asyncio
async def test_restricted_user_with_no_allowed_folders_gets_empty_session_list(monkeypatch):
    app, db, catalog_service, _node_manager = _build_app(monkeypatch)
    catalog_service.list_folders.return_value = []
    async for client in _restricted_client(app):
        resp = await client.get("/api/sessions")

    assert resp.status_code == 200
    assert resp.json()["sessions"] == []
    db.get_all_sessions.assert_not_called()


@pytest.mark.asyncio
async def test_restricted_user_cannot_read_blocked_board_items(monkeypatch):
    app, _db, catalog_service, _node_manager = _build_app(monkeypatch)
    async for client in _restricted_client(app):
        resp = await client.get("/api/board-items?folder_id=blocked-root")

    assert resp.status_code == 403
    catalog_service.list_board_items.assert_not_called()


@pytest.mark.asyncio
async def test_restricted_user_cannot_read_task_container_in_blocked_folder(monkeypatch):
    app, _db, catalog_service, _node_manager = _build_app(monkeypatch)
    catalog_service.get_catalog.return_value = {
        "folders": _folders(),
        "sessions": {},
        "boardItems": [{
            "id": "task:blocked-rb",
            "folderId": "blocked-root",
            "itemType": "task",
            "itemId": "blocked-rb",
            "x": 0,
            "y": 0,
        }],
    }
    async for client in _restricted_client(app):
        resp = await client.get("/api/board-items?container_kind=task&container_id=blocked-rb")

    assert resp.status_code == 403
    catalog_service.list_board_items.assert_not_called()


@pytest.mark.asyncio
async def test_restricted_user_cannot_move_blocked_board_item(monkeypatch):
    app, _db, catalog_service, _node_manager = _build_app(monkeypatch)
    async for client in _restricted_client(app):
        resp = await client.patch(
            "/api/board-items/blocked-item/position",
            json={"x": 20, "y": 40},
        )

    assert resp.status_code == 403
    catalog_service.update_board_item_position.assert_not_called()


@pytest.mark.asyncio
async def test_create_session_service_token_uses_body_caller_email_for_folder_access(monkeypatch):
    app, _db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)

    async for client in _service_token_client(app):
        resp = await client.post(
            "/api/sessions",
            json={
                "prompt": "delegate",
                "nodeId": "node-1",
                "folderId": "blocked-root",
                "caller_info": {"source": "browser", "email": "owner@example.com"},
            },
        )

    assert resp.status_code == 201, resp.text
    ws.send_json.assert_awaited_once()
    assert ws.send_json.await_args.args[0]["folderId"] == "blocked-root"


@pytest.mark.asyncio
async def test_create_session_service_token_without_caller_email_has_full_folder_access(monkeypatch):
    app, _db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)

    async for client in _service_token_client(app):
        resp = await client.post(
            "/api/sessions",
            json={
                "prompt": "delegate",
                "nodeId": "node-1",
                "folderId": "blocked-root",
            },
        )

    assert resp.status_code == 201, resp.text
    ws.send_json.assert_awaited_once()
    assert ws.send_json.await_args.args[0]["folderId"] == "blocked-root"


@pytest.mark.asyncio
async def test_create_session_jwt_restricted_user_cannot_spoof_body_caller_email(monkeypatch):
    app, _db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)

    async for client in _restricted_client(app):
        resp = await client.post(
            "/api/sessions",
            json={
                "prompt": "blocked",
                "nodeId": "node-1",
                "folderId": "blocked-root",
                "caller_info": {"source": "browser", "email": "owner@example.com"},
            },
        )

    assert resp.status_code == 403
    ws.send_json.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_session_jwt_admin_path_regression(monkeypatch):
    app, _db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)

    async for client in _admin_client(app):
        resp = await client.post(
            "/api/sessions",
            json={
                "prompt": "admin",
                "nodeId": "node-1",
                "folderId": "blocked-root",
            },
        )

    assert resp.status_code == 201, resp.text
    ws.send_json.assert_awaited_once()


@pytest.mark.asyncio
async def test_intervene_service_token_uses_body_caller_email_for_session_access(monkeypatch):
    app, db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)
    db.get_session = AsyncMock(return_value=_session("s-blocked", "blocked-root"))

    async for client in _service_token_client(app):
        resp = await client.post(
            "/api/sessions/s-blocked/intervene",
            json={
                "text": "relay",
                "caller_info": {"source": "agent", "email": "owner@example.com"},
            },
        )

    assert resp.status_code == 200, resp.text
    ws.send_json.assert_awaited_once()
    assert ws.send_json.await_args.args[0]["type"] == "intervene"


@pytest.mark.asyncio
async def test_intervene_service_token_without_caller_email_has_full_session_access(monkeypatch):
    app, db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)
    db.get_session = AsyncMock(return_value=_session("s-blocked", "blocked-root"))

    async for client in _service_token_client(app):
        resp = await client.post(
            "/api/sessions/s-blocked/intervene",
            json={"text": "relay"},
        )

    assert resp.status_code == 200, resp.text
    ws.send_json.assert_awaited_once()
    assert ws.send_json.await_args.args[0]["type"] == "intervene"


@pytest.mark.asyncio
async def test_timeline_service_token_without_caller_email_has_full_session_access(monkeypatch):
    app, db, _catalog_service, _node_manager = _build_app(monkeypatch)
    db.get_session = AsyncMock(return_value=_session("s-blocked", "blocked-root"))

    async for client in _service_token_client(app):
        resp = await client.get("/api/sessions/s-blocked/timeline")

    assert resp.status_code == 200, resp.text
    db.read_timeline.assert_awaited_once()


@pytest.mark.asyncio
async def test_intervene_jwt_restricted_user_cannot_spoof_body_caller_email(monkeypatch):
    app, db, _catalog_service, node_manager = _build_app(monkeypatch)
    _node, ws = await _register_node(node_manager)
    db.get_session = AsyncMock(return_value=_session("s-blocked", "blocked-root"))

    async for client in _restricted_client(app):
        resp = await client.post(
            "/api/sessions/s-blocked/intervene",
            json={
                "text": "blocked",
                "caller_info": {"source": "agent", "email": "owner@example.com"},
            },
        )

    assert resp.status_code == 403
    ws.send_json.assert_not_awaited()
