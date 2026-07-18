"""Contract snapshot for the Python orch route surface."""

from tests.orch_contract_helpers import (
    build_full_contract_app,
    configure_contract_settings,
    extract_route_inventory,
    load_contract_fixture,
)


def _order_by_path(routes: list[dict]) -> dict[str, int]:
    return {route["path"]: route["order"] for route in routes}


def test_route_inventory_snapshot_matches_python_orch(monkeypatch):
    configure_contract_settings(monkeypatch)

    actual = {
        "version": 1,
        "routes": extract_route_inventory(build_full_contract_app()),
    }

    assert actual == load_contract_fixture("route_inventory.json")


def test_static_routes_keep_priority_over_dynamic_routes():
    routes = load_contract_fixture("route_inventory.json")["routes"]
    order = _order_by_path(routes)

    assert "/api/nodes/claude-auth/callback" in order
    assert "/api/nodes/{node_id}/claude-auth/callback" not in order
    assert (
        order["/api/sessions/{session_id}/events/viewport"]
        < order["/api/sessions/{session_id}/events"]
    )
    assert order["/api/tasks/my-turn"] < order["/api/tasks/{task_id}"]


def test_public_route_auth_contract_is_explicit():
    public_paths = {
        route["path"]
        for route in load_contract_fixture("route_inventory.json")["routes"]
        if not route["authRequired"]
    }

    assert public_paths == {
        "/ws/node",
        "/api/health",
        "/api/config",
        "/api/auth/google/native",
        "/api/auth/config",
        "/api/auth/google",
        "/api/auth/google/callback",
        "/api/auth/status",
        "/api/auth/logout",
        "/api/auth/dev-login",
        "/yjs/page/{pageId}",
    }


def test_browser_page_routes_are_additive_authenticated_contracts():
    routes = load_contract_fixture("route_inventory.json")["routes"]
    by_key = {
        (method, route["path"]): route
        for route in routes
        for method in route["methods"]
    }
    expected = {
        ("GET", "/api/pages"),
        ("POST", "/api/pages/daily"),
        ("GET", "/api/pages/{pageId}"),
        ("POST", "/api/pages/{pageId}/operations"),
        ("PATCH", "/api/pages/{pageId}/starred"),
    }

    assert expected <= by_key.keys()
    assert all(by_key[key]["authRequired"] is True for key in expected)
