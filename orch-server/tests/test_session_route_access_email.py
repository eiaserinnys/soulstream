"""Access-email propagation tests for session-scoped mutating routes."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from soul_common.auth.jwt import COOKIE_NAME, generate_token
from soulstream_server.config import get_settings
from soulstream_server.main import create_app
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter
from soulstream_server.users import DashboardUserService
from tests.conftest import TEST_AUTH_TOKEN


JWT_SECRET = "test-jwt-secret-for-session-access-email-32b"
RESTRICTED_EMAIL = "restricted@example.com"
OWNER_EMAIL = "owner@example.com"
ACCESS_ENV = (
    '{"restricted@example.com":'
    '{"restricted":true,"allowedFolderIds":["allowed-root"]}}'
)


def _session(session_id: str, folder_id: str) -> dict:
    return {
        "session_id": session_id,
        "node_id": "node-1",
        "agent_id": None,
        "status": "running",
        "session_type": "claude",
        "created_at": "2026-06-07T00:00:00",
        "updated_at": "2026-06-07T00:00:00",
        "last_event_id": 10,
        "last_read_event_id": 0,
        "prompt": "hello",
        "last_message": None,
        "metadata": [],
        "folder_id": folder_id,
    }


def _folders() -> list[dict]:
    return [
        {"id": "allowed-root", "name": "Allowed", "sortOrder": 0, "parentFolderId": None},
        {"id": "blocked-root", "name": "Blocked", "sortOrder": 1, "parentFolderId": None},
    ]


def _build_app(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ALLOWED_EMAIL", OWNER_EMAIL)
    monkeypatch.setenv("DASHBOARD_USER_FOLDER_ACCESS", ACCESS_ENV)
    get_settings.cache_clear()

    db = MagicMock()
    db.get_session = AsyncMock(return_value=_session("s-blocked", "blocked-root"))
    db.get_all_folders = AsyncMock(return_value=_folders())
    db.update_last_read_event_id = AsyncMock()
    db.get_read_position = AsyncMock(return_value=(10, 10))

    catalog_service = MagicMock()
    catalog_service.list_folders = AsyncMock(return_value=_folders())
    catalog_service.rename_session = AsyncMock()
    catalog_service.move_sessions_to_folder = AsyncMock()
    catalog_service.delete_session = AsyncMock()
    catalog_service.broadcast_catalog = AsyncMock()
    catalog_service.list_session_assignments = AsyncMock(return_value={})
    catalog_service.get_catalog = AsyncMock(return_value={
        "folders": _folders(),
        "sessions": {},
        "boardItems": [],
    })

    node = MagicMock()
    node.node_id = "node-1"
    node.sessions = {}
    node.send_claude_runtime_background_tasks = AsyncMock(
        return_value={"status": "ok", "backgrounded": True},
    )
    node.send_respond = AsyncMock(return_value={"success": True})
    node.send_tool_approval = AsyncMock(return_value={"status": "ok"})
    node.send_realtime_create_call = AsyncMock(
        return_value={"status": "ok", "answerSdp": "answer"},
    )
    node.send_realtime_event = AsyncMock(
        return_value={"status": "ok", "normalizedType": "realtime_transcript"},
    )
    node.send_realtime_tool_approval = AsyncMock(return_value={"status": "ok"})
    node.send_streamed_upload_attachment = AsyncMock(
        side_effect=_upload_attachment_response,
    )

    node_manager = NodeManager()
    node_manager._nodes["node-1"] = node

    user_service = DashboardUserService.memory_from_settings(get_settings())
    app = create_app(
        db=db,
        node_manager=node_manager,
        session_router=SessionRouter(node_manager),
        broadcaster=SessionBroadcaster(),
        catalog_service=catalog_service,
        user_service=user_service,
    )
    return app, db, catalog_service, node


async def _upload_attachment_response(**kwargs):
    content = b""
    async for chunk in kwargs["chunks"]:
        content += chunk
    return {
        "path": f"/incoming/{kwargs['session_id']}/{kwargs['filename']}",
        "filename": kwargs["filename"],
        "size": len(content),
        "content_type": kwargs["content_type"],
    }


def _caller_info() -> dict:
    return {"source": "agent", "email": OWNER_EMAIL}


async def _service_token_client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {TEST_AUTH_TOKEN}"},
    ) as client:
        yield client


async def _jwt_client(app, email: str):
    token = generate_token({"email": email, "name": email}, JWT_SECRET)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: token},
    ) as client:
        yield client


@dataclass(frozen=True)
class RouteCase:
    name: str
    method: str
    path: str
    body: dict
    effect: Callable[[object, object, object], AsyncMock]


ROUTE_CASES = [
    RouteCase(
        name="background-action",
        method="post",
        path="/api/sessions/s-blocked/background-tasks/background",
        body={"toolUseId": "toolu-bash"},
        effect=lambda db, catalog, node: node.send_claude_runtime_background_tasks,
    ),
    RouteCase(
        name="respond",
        method="post",
        path="/api/sessions/s-blocked/respond",
        body={"requestId": "input-1", "answers": {"choice": "yes"}},
        effect=lambda db, catalog, node: node.send_respond,
    ),
    RouteCase(
        name="tool-approve",
        method="post",
        path="/api/sessions/s-blocked/tool-approvals/approval-1/approve",
        body={"message": "ok"},
        effect=lambda db, catalog, node: node.send_tool_approval,
    ),
    RouteCase(
        name="tool-reject",
        method="post",
        path="/api/sessions/s-blocked/tool-approvals/approval-1/reject",
        body={"message": "no"},
        effect=lambda db, catalog, node: node.send_tool_approval,
    ),
    RouteCase(
        name="realtime-call",
        method="post",
        path="/api/sessions/s-blocked/realtime/call",
        body={"offerSdp": "offer", "voice": "alloy"},
        effect=lambda db, catalog, node: node.send_realtime_create_call,
    ),
    RouteCase(
        name="realtime-event",
        method="post",
        path="/api/sessions/s-blocked/realtime/events",
        body={"callId": "call-1", "event": {"type": "response.audio_transcript.done"}},
        effect=lambda db, catalog, node: node.send_realtime_event,
    ),
    RouteCase(
        name="realtime-tool-approval",
        method="post",
        path="/api/sessions/s-blocked/realtime/tool-approvals/approval-1/resolve",
        body={"decision": "approved", "source": "tap", "callId": "call-1"},
        effect=lambda db, catalog, node: node.send_realtime_tool_approval,
    ),
    RouteCase(
        name="rename",
        method="patch",
        path="/api/sessions/s-blocked/display-name",
        body={"displayName": "Renamed"},
        effect=lambda db, catalog, node: catalog.rename_session,
    ),
    RouteCase(
        name="batch-move",
        method="patch",
        path="/api/sessions/folder",
        body={"sessionIds": ["s-blocked"], "folderId": "blocked-root"},
        effect=lambda db, catalog, node: catalog.move_sessions_to_folder,
    ),
    RouteCase(
        name="catalog-update",
        method="put",
        path="/api/sessions/s-blocked",
        body={"folderId": "blocked-root"},
        effect=lambda db, catalog, node: catalog.move_sessions_to_folder,
    ),
    RouteCase(
        name="read-position",
        method="put",
        path="/api/sessions/s-blocked/read-position",
        body={"last_read_event_id": 10},
        effect=lambda db, catalog, node: db.update_last_read_event_id,
    ),
]


async def _send_json(client: AsyncClient, case: RouteCase, *, with_caller_info: bool):
    body = dict(case.body)
    if with_caller_info:
        body["caller_info"] = _caller_info()
    return await getattr(client, case.method)(case.path, json=body)


@pytest.mark.parametrize("case", ROUTE_CASES, ids=[case.name for case in ROUTE_CASES])
@pytest.mark.asyncio
async def test_service_token_uses_body_caller_email_for_session_routes(monkeypatch, case):
    app, db, catalog, node = _build_app(monkeypatch)

    async for client in _service_token_client(app):
        resp = await _send_json(client, case, with_caller_info=True)

    assert resp.status_code < 300, resp.text
    case.effect(db, catalog, node).assert_awaited()


@pytest.mark.parametrize("case", ROUTE_CASES, ids=[case.name for case in ROUTE_CASES])
@pytest.mark.asyncio
async def test_service_token_without_body_caller_email_has_unrestricted_session_route_access(
    monkeypatch,
    case,
):
    app, db, catalog, node = _build_app(monkeypatch)

    async for client in _service_token_client(app):
        resp = await _send_json(client, case, with_caller_info=False)

    assert resp.status_code < 300, resp.text
    case.effect(db, catalog, node).assert_awaited()


@pytest.mark.parametrize("case", ROUTE_CASES, ids=[case.name for case in ROUTE_CASES])
@pytest.mark.asyncio
async def test_jwt_restricted_user_cannot_spoof_body_caller_email(monkeypatch, case):
    app, db, catalog, node = _build_app(monkeypatch)

    async for client in _jwt_client(app, RESTRICTED_EMAIL):
        resp = await _send_json(client, case, with_caller_info=True)

    assert resp.status_code == 403
    case.effect(db, catalog, node).assert_not_awaited()


@pytest.mark.parametrize("case", ROUTE_CASES, ids=[case.name for case in ROUTE_CASES])
@pytest.mark.asyncio
async def test_jwt_admin_session_route_regression(monkeypatch, case):
    app, db, catalog, node = _build_app(monkeypatch)

    async for client in _jwt_client(app, OWNER_EMAIL):
        resp = await _send_json(client, case, with_caller_info=False)

    assert resp.status_code < 300, resp.text
    case.effect(db, catalog, node).assert_awaited()


async def _post_upload(client: AsyncClient, *, with_caller_info: bool):
    data = {"session_id": "s-blocked"}
    if with_caller_info:
        data["caller_info"] = json.dumps(_caller_info())
    return await client.post(
        "/api/attachments/sessions?nodeId=node-1",
        data=data,
        files={"file": ("note.txt", b"hello", "text/plain")},
    )


@pytest.mark.asyncio
async def test_service_token_uses_multipart_caller_email_for_attachment_upload(monkeypatch):
    app, _db, _catalog, node = _build_app(monkeypatch)

    async for client in _service_token_client(app):
        resp = await _post_upload(client, with_caller_info=True)

    assert resp.status_code == 201, resp.text
    node.send_streamed_upload_attachment.assert_awaited_once()


@pytest.mark.asyncio
async def test_service_token_without_multipart_caller_email_has_unrestricted_upload_access(
    monkeypatch,
):
    app, _db, _catalog, node = _build_app(monkeypatch)

    async for client in _service_token_client(app):
        resp = await _post_upload(client, with_caller_info=False)

    assert resp.status_code == 201, resp.text
    node.send_streamed_upload_attachment.assert_awaited_once()


@pytest.mark.asyncio
async def test_jwt_restricted_user_cannot_spoof_multipart_caller_email(monkeypatch):
    app, _db, _catalog, node = _build_app(monkeypatch)

    async for client in _jwt_client(app, RESTRICTED_EMAIL):
        resp = await _post_upload(client, with_caller_info=True)

    assert resp.status_code == 403
    node.send_streamed_upload_attachment.assert_not_awaited()


@pytest.mark.asyncio
async def test_jwt_admin_attachment_upload_regression(monkeypatch):
    app, _db, _catalog, node = _build_app(monkeypatch)

    async for client in _jwt_client(app, OWNER_EMAIL):
        resp = await _post_upload(client, with_caller_info=False)

    assert resp.status_code == 201, resp.text
    node.send_streamed_upload_attachment.assert_awaited_once()
