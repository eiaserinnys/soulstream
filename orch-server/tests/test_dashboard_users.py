"""Dashboard User domain tests."""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from soul_common.auth.jwt import COOKIE_NAME, generate_token
from soulstream_server.config import get_settings
from soulstream_server.main import create_app
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter
from soulstream_server.users import (
    DashboardUser,
    DashboardUserService,
    InMemoryDashboardUserRepository,
    seed_users_from_settings,
)


JWT_SECRET = "test-jwt-secret-for-dashboard-users-32"


def _user(
    email: str,
    *,
    is_admin: bool = False,
    allowed_folder_ids: tuple[str, ...] = (),
) -> DashboardUser:
    return DashboardUser(
        email=email,
        display_name=None,
        is_admin=is_admin,
        allowed_folder_ids=allowed_folder_ids,
        created_at=datetime.now(timezone.utc),
        created_by="test",
    )


def _service(*users: DashboardUser) -> DashboardUserService:
    service = DashboardUserService(InMemoryDashboardUserRepository(users))
    service.cache.replace(users)
    return service


def _build_app(monkeypatch, user_service: DashboardUserService):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "google-client")
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ALLOWED_EMAIL", "owner@example.com")
    get_settings.cache_clear()

    db = MagicMock()
    catalog_service = MagicMock()
    catalog_service.list_folders = AsyncMock(return_value=[
        {"id": "root", "name": "Root", "sortOrder": 0, "parentFolderId": None},
        {"id": "child", "name": "Child", "sortOrder": 1, "parentFolderId": "root"},
    ])
    catalog_service.broadcast_catalog = AsyncMock()

    node_manager = NodeManager()
    broadcaster = SessionBroadcaster()
    return create_app(
        db=db,
        node_manager=node_manager,
        session_router=SessionRouter(node_manager),
        broadcaster=broadcaster,
        catalog_service=catalog_service,
        user_service=user_service,
    ), catalog_service


def _token(email: str) -> str:
    return generate_token({"email": email, "name": email}, JWT_SECRET)


@pytest.mark.asyncio
async def test_init_seed_is_idempotent(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("PORT", "3105")
    monkeypatch.setenv("DATABASE_URL", "postgresql://example/test")
    monkeypatch.setenv("ALLOWED_EMAIL", "Owner@Example.com")
    monkeypatch.setenv(
        "DASHBOARD_USER_FOLDER_ACCESS",
        '{"Bellon.LoveDive@gmail.com":{"allowedFolderIds":["root","child"]}}',
    )
    get_settings.cache_clear()
    settings = get_settings()

    service = _service()
    await seed_users_from_settings(service, settings)
    await seed_users_from_settings(service, settings)

    users = await service.list_users()
    assert [user.email for user in users] == [
        "bellon.lovedive@gmail.com",
        "owner@example.com",
    ]
    assert service.cache.get("owner@example.com").is_admin is True
    assert service.cache.get("bellon.lovedive@gmail.com").allowed_folder_ids == ("root", "child")


def test_user_cache_resolves_dashboard_access():
    service = _service(
        _user("admin@example.com", is_admin=True),
        _user("limited@example.com", allowed_folder_ids=("root",)),
        _user("open@example.com"),
    )

    assert service.access_for_email("admin@example.com").restricted is False
    assert service.access_for_email("open@example.com").restricted is False
    limited = service.access_for_email("limited@example.com")
    assert limited.restricted is True
    assert limited.allowed_folder_ids == ("root",)
    assert service.access_for_email("missing@example.com").restricted is True


def test_oauth_gate_reports_empty_user_table():
    service = _service()

    assert service.oauth_error_for_email("owner@example.com") == "no_admin_initialized"


@pytest.mark.asyncio
async def test_admin_users_crud_and_broadcast(monkeypatch):
    service = _service(_user("admin@example.com", is_admin=True))
    app, catalog_service = _build_app(monkeypatch, service)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: _token("admin@example.com")},
    ) as client:
        created = await client.post(
            "/api/admin/users",
            json={
                "email": "Bellon.LoveDive@gmail.com",
                "displayName": "Bellon",
                "isAdmin": False,
                "allowedFolderIds": ["root"],
            },
        )
        patched = await client.patch(
            "/api/admin/users/bellon.lovedive%40gmail.com",
            json={"allowedFolderIds": ["root", "child"]},
        )
        listed = await client.get("/api/admin/users")

    assert created.status_code == 201
    assert created.json()["user"]["email"] == "bellon.lovedive@gmail.com"
    assert patched.status_code == 200
    assert patched.json()["user"]["allowedFolderIds"] == ["root", "child"]
    assert listed.status_code == 200
    assert [user["email"] for user in listed.json()["users"]] == [
        "admin@example.com",
        "bellon.lovedive@gmail.com",
    ]
    assert catalog_service.broadcast_catalog.await_count == 2


@pytest.mark.asyncio
async def test_admin_users_denies_non_admin(monkeypatch):
    service = _service(_user("limited@example.com", allowed_folder_ids=("root",)))
    app, _catalog_service = _build_app(monkeypatch, service)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: _token("limited@example.com")},
    ) as client:
        resp = await client.get("/api/admin/users")

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_single_admin_cannot_delete_self(monkeypatch):
    service = _service(_user("admin@example.com", is_admin=True))
    app, _catalog_service = _build_app(monkeypatch, service)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        cookies={COOKIE_NAME: _token("admin@example.com")},
    ) as client:
        resp = await client.delete("/api/admin/users/admin%40example.com")

    assert resp.status_code == 400
    assert resp.json()["detail"] == "At least one admin user is required"
