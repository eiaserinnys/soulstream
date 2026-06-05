"""Deprecated API path responses.

Old desktop bundles can keep calling removed endpoints from a stale WebView2 cache.
These paths must return explicit 410 guidance instead of silent 404s.
"""

from __future__ import annotations

import pytest


pytestmark = pytest.mark.asyncio


async def test_node_oauth_profiles_returns_410_with_replacement(client):
    resp = await client.get("/api/nodes/eiaserinnys/oauth-profiles")

    assert resp.status_code == 410
    assert resp.headers["x-soulstream-deprecated-path"] == (
        "/api/nodes/eiaserinnys/oauth-profiles"
    )
    assert resp.headers["x-soulstream-replacement-path"] == (
        "/api/nodes/eiaserinnys/claude-auth/profiles"
    )
    assert resp.headers["x-soulstream-desktop-action"] == "hard-reload"
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert body["error"]["code"] == "DEPRECATED_API_PATH"
    assert body["error"]["replacementPath"] == (
        "/api/nodes/eiaserinnys/claude-auth/profiles"
    )


async def test_session_message_returns_410_with_intervene_replacement(client):
    resp = await client.post("/api/sessions/sess-1/message", json={"text": "hello"})

    assert resp.status_code == 410
    assert resp.headers["x-soulstream-deprecated-path"] == "/api/sessions/sess-1/message"
    assert resp.headers["x-soulstream-replacement-path"] == (
        "/api/sessions/sess-1/intervene"
    )
    body = resp.json()
    assert body["error"]["code"] == "DEPRECATED_API_PATH"
    assert body["error"]["replacementMethod"] == "POST"
