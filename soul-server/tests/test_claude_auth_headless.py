"""
soul-server Claude Auth headless OAuth 엔드포인트 테스트

GET  /auth/claude/headless/start
POST /auth/claude/headless/submit-code
"""

import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_server.api.claude_auth.router import create_claude_auth_router


@pytest.fixture
def test_env_path(tmp_path: Path) -> Path:
    return tmp_path / ".env"


@pytest.fixture
def client(test_env_path: Path):
    app = FastAPI()
    router = create_claude_auth_router(env_path=test_env_path)
    app.include_router(router, prefix="/auth/claude")
    return TestClient(app)


class TestHeadlessStart:
    """GET /auth/claude/headless/start"""

    def test_returns_auth_url(self, client, monkeypatch):
        """정상 동작: authUrl JSON 반환."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.get("/auth/claude/headless/start")

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

    def test_auth_url_contains_headless_scope(self, client, monkeypatch):
        """authUrl에 org:create_api_key 스코프 포함."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.get("/auth/claude/headless/start")

        assert resp.status_code == 200
        auth_url = resp.json()["authUrl"]
        assert "org%3Acreate_api_key" in auth_url

    def test_no_auth_required(self, client, monkeypatch):
        """인증 헤더 없이 접근 가능 (headless 환경 고려)."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.get("/auth/claude/headless/start")

        assert resp.status_code == 200

    def test_each_call_generates_unique_state(self, client, monkeypatch):
        """호출마다 다른 state 생성."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        from urllib.parse import urlparse, parse_qs

        resp1 = client.get("/auth/claude/headless/start")
        resp2 = client.get("/auth/claude/headless/start")

        state1 = parse_qs(urlparse(resp1.json()["authUrl"]).query)["state"][0]
        state2 = parse_qs(urlparse(resp2.json()["authUrl"]).query)["state"][0]
        assert state1 != state2


class TestHeadlessSubmitCode:
    """POST /auth/claude/headless/submit-code"""

    def _get_state_from_start(self, client, monkeypatch) -> str:
        """headless/start 호출 후 state 반환 헬퍼."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")
        resp = client.get("/auth/claude/headless/start")
        from urllib.parse import urlparse, parse_qs
        return parse_qs(urlparse(resp.json()["authUrl"]).query)["state"][0]

    def test_success(self, client, monkeypatch, test_env_path: Path):
        """정상 동작: 토큰 교환 후 credentials.json에 저장, success 반환."""
        state = self._get_state_from_start(client, monkeypatch)
        paste_code = f"authcode-abc#{state}"

        fake_token_resp = MagicMock()
        fake_token_resp.status_code = 200
        fake_token_resp.json.return_value = {
            "access_token": "sk-ant-oat01-faketoken",
            "refresh_token": "rt-fake-refresh",
            "expires_in": 3600,
            "scope": "org:create_api_key",
        }

        with patch("soul_server.api.claude_auth.router.httpx.AsyncClient") as mock_cls, \
             patch("soul_server.api.claude_auth.router.save_credentials_json") as mock_save_creds:
            mock_http = AsyncMock()
            mock_http.post = AsyncMock(return_value=fake_token_resp)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_http)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=None)

            resp = client.post(
                "/auth/claude/headless/submit-code",
                json={"code": paste_code},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        # credentials.json에 저장되었는지 확인
        mock_save_creds.assert_called_once_with(
            "sk-ant-oat01-faketoken", "rt-fake-refresh",
            expires_in=3600, scope="org:create_api_key",
        )

    def test_missing_code(self, client, monkeypatch):
        """빈 code: 400 missing_code."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.post("/auth/claude/headless/submit-code", json={"code": ""})

        assert resp.status_code == 400
        assert resp.json()["detail"] == "missing_code"

    def test_whitespace_only_code(self, client, monkeypatch):
        """공백만 있는 code: 400 missing_code."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.post("/auth/claude/headless/submit-code", json={"code": "   "})

        assert resp.status_code == 400
        assert resp.json()["detail"] == "missing_code"

    def test_invalid_code_format(self, client, monkeypatch):
        """# 없는 code: 400 invalid_code_format."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.post(
            "/auth/claude/headless/submit-code",
            json={"code": "authcode-without-hash"},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "invalid_code_format"

    def test_invalid_state(self, client, monkeypatch):
        """알 수 없는 state: 400 invalid_state."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        resp = client.post(
            "/auth/claude/headless/submit-code",
            json={"code": "authcode-abc#unknown-state-xyz"},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "invalid_state"

    def test_state_consumed_after_use(self, client, monkeypatch):
        """state는 1회만 사용 가능 — 두 번째 제출 시 invalid_state."""
        state = self._get_state_from_start(client, monkeypatch)
        paste_code = f"authcode-abc#{state}"

        fake_token_resp = MagicMock()
        fake_token_resp.status_code = 200
        fake_token_resp.json.return_value = {"access_token": "sk-ant-oat01-faketoken"}

        with patch("soul_server.api.claude_auth.router.httpx.AsyncClient") as mock_cls:
            mock_http = AsyncMock()
            mock_http.post = AsyncMock(return_value=fake_token_resp)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_http)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=None)

            resp1 = client.post("/auth/claude/headless/submit-code", json={"code": paste_code})

        assert resp1.status_code == 200

        # 동일 state로 재시도
        resp2 = client.post("/auth/claude/headless/submit-code", json={"code": paste_code})
        assert resp2.status_code == 400
        assert resp2.json()["detail"] == "invalid_state"

    def test_token_exchange_failed(self, client, monkeypatch):
        """토큰 교환 실패: 400 token_exchange_failed."""
        state = self._get_state_from_start(client, monkeypatch)

        fake_error_resp = MagicMock()
        fake_error_resp.status_code = 400
        fake_error_resp.text = "invalid_grant"

        with patch("soul_server.api.claude_auth.router.httpx.AsyncClient") as mock_cls:
            mock_http = AsyncMock()
            mock_http.post = AsyncMock(return_value=fake_error_resp)
            mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_http)
            mock_cls.return_value.__aexit__ = AsyncMock(return_value=None)

            resp = client.post(
                "/auth/claude/headless/submit-code",
                json={"code": f"authcode-abc#{state}"},
            )

        assert resp.status_code == 400
        assert "token_exchange_failed" in resp.json()["detail"]

    def test_no_auth_required(self, client, monkeypatch):
        """인증 헤더 없이 접근 가능 (headless 환경 고려)."""
        monkeypatch.setenv("CLAUDE_OAUTH_CLIENT_ID", "test-client-id")

        # 존재하지 않는 state여도 401이 아닌 400이어야 함
        resp = client.post(
            "/auth/claude/headless/submit-code",
            json={"code": "authcode#nonexistent-state"},
        )

        assert resp.status_code == 400
        assert resp.json()["detail"] == "invalid_state"
