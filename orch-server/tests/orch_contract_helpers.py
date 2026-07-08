"""Helpers for orch TS transition contract fixture tests."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from fastapi.routing import APIRoute
from starlette.routing import WebSocketRoute

from soulstream_server.config import get_settings
from soulstream_server.main import create_app
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter


FIXTURE_DIR = Path(__file__).parent / "fixtures" / "orch_contract"


def load_contract_fixture(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def configure_contract_settings(monkeypatch) -> None:
    values = {
        "HOST": "0.0.0.0",
        "PORT": "5200",
        "DATABASE_URL": "postgresql://test:test@localhost:5432/test",
        "ENVIRONMENT": "development",
        "AUTH_BEARER_TOKEN": "test-bearer-token-for-testing",
        "CORS_ALLOWED_ORIGINS": '["http://testserver"]',
        "DASHBOARD_DIR": "",
        "GOOGLE_CLIENT_ID": "test-google-client",
        "GOOGLE_CLIENT_SECRET": "test-google-secret",
        "GOOGLE_CALLBACK_URL": "http://test/api/auth/google/callback",
        "GOOGLE_IOS_CLIENT_ID": "test-ios-client",
        "JWT_SECRET": "test-jwt-secret",
        "ALLOWED_EMAIL": "test@example.com",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


def _async_method(value=None) -> AsyncMock:
    return AsyncMock(return_value=value)


def build_full_contract_app():
    db = MagicMock()
    for name, value in {
        "get_all_sessions": ([], 0),
        "get_session": None,
        "read_events": [],
        "assign_session_to_folder": None,
        "get_all_folders": [],
        "create_folder": None,
        "update_folder": None,
        "delete_folder": None,
        "get_catalog": {"folders": [], "sessions": {}},
        "get_runbook_snapshot": None,
        "get_runbook_overview": {"my_turn_items": [], "runbooks": []},
    }.items():
        setattr(db, name, _async_method(value))

    node_manager = NodeManager()
    catalog_service = MagicMock()
    for name, value in {
        "list_folders": [],
        "get_catalog": {"folders": [], "sessions": {}},
        "list_board_items": [],
        "list_session_assignments": {},
        "get_markdown_document": {"id": "doc-1"},
    }.items():
        setattr(catalog_service, name, _async_method(value))
    for name in [
        "create_folder",
        "rename_folder",
        "update_folder",
        "delete_folder",
        "reorder_folders",
        "broadcast_catalog",
        "move_sessions_to_folder",
        "rename_session",
        "delete_session",
        "update_board_item_position",
        "init_file_asset",
        "commit_file_asset",
        "create_markdown_document",
        "update_markdown_document",
        "delete_markdown_document",
    ]:
        setattr(catalog_service, name, _async_method({}))

    user_service = MagicMock()
    user_service.oauth_error_for_email.return_value = None
    user_service.user_payload_extra.return_value = {}

    return create_app(
        db=db,
        node_manager=node_manager,
        session_router=SessionRouter(node_manager),
        broadcaster=SessionBroadcaster(),
        catalog_service=catalog_service,
        push_repo=MagicMock(),
        user_service=user_service,
        user_preferences_repo=MagicMock(),
    )


def _include_contract_path(path: str) -> bool:
    return path == "/ws/node" or path.startswith("/api/") or path.startswith("/cogito/")


def extract_route_inventory(app) -> list[dict]:
    entries: list[dict] = []

    def add_entry(methods, path: str, name: str, dependencies: list[str]) -> None:
        if not _include_contract_path(path):
            return
        entries.append({
            "order": len(entries),
            "methods": sorted(methods),
            "path": path,
            "name": name,
            "authRequired": "verify_auth" in dependencies,
        })

    for route in app.routes:
        if isinstance(route, APIRoute):
            deps = [
                getattr(dep.call, "__name__", repr(dep.call))
                for dep in route.dependant.dependencies
            ]
            add_entry(route.methods, route.path, route.name, deps)
        elif isinstance(route, WebSocketRoute):
            add_entry(["WEBSOCKET"], route.path, route.name, [])
        elif type(route).__name__ == "_IncludedRouter":
            for ctx in route.effective_route_contexts():
                deps = [
                    getattr(dep.dependency, "__name__", repr(dep.dependency))
                    for dep in ctx.dependencies
                ]
                add_entry(ctx.methods, ctx.path, ctx.name, deps)

    return entries
