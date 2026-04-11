"""Tests for soulstream-server Claude Auth headless OAuth endpoints.

GET  /api/nodes/{node_id}/claude-auth/headless/start
POST /api/nodes/{node_id}/claude-auth/headless/submit-code
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from soulstream_server.api.claude_auth import create_claude_auth_router
from soulstream_server.nodes.node_manager import NodeManager


@pytest.fixture
def node_manager():
    return NodeManager()


@pytest.fixture
def test_app(node_manager):
    app = FastAPI()
    app.include_router(create_claude_auth_router(node_manager))
    return app


@pytest.fixture
async def client(test_app):
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def mock_node_conn():
    conn = MagicMock()
    conn.send_claude_auth_set_token = AsyncMock(return_value={"success": True})
    return conn


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


class TestHeadlessStart:
    """GET /api/nodes/{node_id}/claude-auth/headless/start"""

    async def test_returns_auth_url(self, client, node_manager, monkeypatch):
        """정상 동작: authUrl JSON 반환."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        resp = await client.get(f"/api/nodes/{node_id}/claude-auth/headless/start")

        assert resp.status_code == 200
        data = resp.json()
        assert "authUrl" in data
        auth_url = data["authUrl"]
        assert "claude.com/cai/oauth/authorize" in auth_url
        assert "code=true" in auth_url
        assert "client_id=test-client-id" in auth_url
        assert "redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" in auth_url
        assert "code_challenge_method=S256" in auth_url
        assert "state=" in auth_url

    async def test_returns_404_when_node_not_connected(self, client, monkeypatch):
        """노드 미연결: 404 반환."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = await client.get("/api/nodes/nonexistent-node/claude-auth/headless/start")

        assert resp.status_code == 404
        assert "not connected" in resp.json()["detail"]

    async def test_auth_url_contains_headless_scope(self, client, node_manager, monkeypatch):
        """authUrl에 org:create_api_key 스코프 포함."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        resp = await client.get(f"/api/nodes/{node_id}/claude-auth/headless/start")

        assert resp.status_code == 200
        auth_url = resp.json()["authUrl"]
        assert "org%3Acreate_api_key" in auth_url


class TestHeadlessSubmitCode:
    """POST /api/nodes/{node_id}/claude-auth/headless/submit-code"""

    async def test_success(self, client, node_manager, monkeypatch):
        """정상 동작: 토큰 교환 후 WS push, success 반환."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        # headless/start로 state를 생성
        start_resp = await client.get(f"/api/nodes/{node_id}/claude-auth/headless/start")
        auth_url = start_resp.json()["authUrl"]
        # state 파라미터 추출
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(auth_url)
        state = parse_qs(parsed.query)["state"][0]
        paste_code = f"authcode-abc123#{state}"

        # node_conn mock
        conn = node_manager.get_node(node_id)
        conn.send_claude_auth_set_token = AsyncMock(return_value={"success": True})

        fake_token_resp = MagicMock()
        fake_token_resp.status_code = 200
        fake_token_resp.json.return_value = {"access_token": "sk-ant-oat01-faketoken"}

        with patch("soulstream_server.api.claude_auth.httpx.AsyncClient") as mock_client_cls:
            mock_http = AsyncMock()
            mock_http.post = AsyncMock(return_value=fake_token_resp)
            mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_http)
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

            resp = await client.post(
                f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
                json={"code": paste_code},
            )

        assert resp.status_code == 200
        assert resp.json()["success"] is True
        # OAuth 응답에 refresh_token이 없으면 refresh_token=None, expires_in=None, scope="" 으로 호출
        conn.send_claude_auth_set_token.assert_called_once_with(
            "sk-ant-oat01-faketoken",
            refresh_token=None,
            expires_in=None,
            scope="",
        )

    async def test_success_with_refresh_token(self, client, node_manager, monkeypatch):
        """정상 동작: refresh_token + expires_in + scope이 있으면 함께 전달."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        start_resp = await client.get(f"/api/nodes/{node_id}/claude-auth/headless/start")
        auth_url = start_resp.json()["authUrl"]
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(auth_url)
        state = parse_qs(parsed.query)["state"][0]
        paste_code = f"authcode-abc123#{state}"

        conn = node_manager.get_node(node_id)
        conn.send_claude_auth_set_token = AsyncMock(return_value={"success": True})

        fake_token_resp = MagicMock()
        fake_token_resp.status_code = 200
        fake_token_resp.json.return_value = {
            "access_token": "sk-ant-oat01-faketoken",
            "refresh_token": "refresh-xyz",
            "expires_in": 28800,
            "scope": "user:inference user:profile",
        }

        with patch("soulstream_server.api.claude_auth.httpx.AsyncClient") as mock_client_cls:
            mock_http = AsyncMock()
            mock_http.post = AsyncMock(return_value=fake_token_resp)
            mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_http)
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

            resp = await client.post(
                f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
                json={"code": paste_code},
            )

        assert resp.status_code == 200
        assert resp.json()["success"] is True
        conn.send_claude_auth_set_token.assert_called_once_with(
            "sk-ant-oat01-faketoken",
            refresh_token="refresh-xyz",
            expires_in=28800,
            scope="user:inference user:profile",
        )

    async def test_missing_code(self, client, node_manager, monkeypatch):
        """빈 code: 400 missing_code."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        resp = await client.post(
            f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
            json={"code": ""},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "missing_code"

    async def test_invalid_code_format(self, client, node_manager, monkeypatch):
        """# 없는 code: 400 invalid_code_format."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        resp = await client.post(
            f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
            json={"code": "authcode-without-hash"},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "invalid_code_format"

    async def test_invalid_state(self, client, node_manager, monkeypatch):
        """알 수 없는 state: 400 invalid_state."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        resp = await client.post(
            f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
            json={"code": "authcode-abc#unknown-state-xyz"},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "invalid_state"

    async def test_node_id_mismatch(self, client, node_manager, monkeypatch):
        """state의 node_id가 URL의 node_id와 불일치: 400 node_id mismatch."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager, "node-a")
        await _register_node(node_manager, "node-b")

        # node-a의 state를 node-b 엔드��인트에 제출
        start_resp = await client.get(f"/api/nodes/node-a/claude-auth/headless/start")
        auth_url = start_resp.json()["authUrl"]
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(auth_url)
        state = parse_qs(parsed.query)["state"][0]

        resp = await client.post(
            "/api/nodes/node-b/claude-auth/headless/submit-code",
            json={"code": f"authcode-abc#{state}"},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "node_id mismatch"

    async def test_token_exchange_failed(self, client, node_manager, monkeypatch):
        """토큰 교환 실패: 400 token_exchange_failed."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        start_resp = await client.get(f"/api/nodes/{node_id}/claude-auth/headless/start")
        auth_url = start_resp.json()["authUrl"]
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(auth_url)
        state = parse_qs(parsed.query)["state"][0]

        fake_error_resp = MagicMock()
        fake_error_resp.status_code = 400
        fake_error_resp.text = "invalid_grant"

        with patch("soulstream_server.api.claude_auth.httpx.AsyncClient") as mock_client_cls:
            mock_http = AsyncMock()
            mock_http.post = AsyncMock(return_value=fake_error_resp)
            mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_http)
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

            resp = await client.post(
                f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
                json={"code": f"authcode-abc#{state}"},
            )

        assert resp.status_code == 400
        assert "token_exchange_failed" in resp.json()["detail"]

    async def test_node_not_connected_after_state_pop(self, client, node_manager, monkeypatch):
        """state 검증 후 노드 연결 끊김: 404."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        node_id = await _register_node(node_manager)

        start_resp = await client.get(f"/api/nodes/{node_id}/claude-auth/headless/start")
        auth_url = start_resp.json()["authUrl"]
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(auth_url)
        state = parse_qs(parsed.query)["state"][0]

        # 노드 연결 해제 (동기 메서드)
        node_manager.unregister_node(node_id)

        resp = await client.post(
            f"/api/nodes/{node_id}/claude-auth/headless/submit-code",
            json={"code": f"authcode-abc#{state}"},
        )

        assert resp.status_code == 404
