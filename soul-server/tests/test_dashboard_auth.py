"""
Dashboard 인증 테스트 — auth.py + auth_routes.py (soul-common 팩토리 기반)

두 시나리오를 모두 테스트한다:
1. 인증 비활성 (GOOGLE_CLIENT_ID 미설정) → 바이패스
2. 인증 활성 (GOOGLE_CLIENT_ID 설정) → JWT 검증
"""

import os
import pytest
from unittest.mock import patch, AsyncMock, MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_server.dashboard.auth import (
    generate_token,
    verify_token,
    require_dashboard_auth,
    COOKIE_NAME,
)
from soul_common.auth.oauth_routes import create_oauth_router, OAUTH_STATE_COOKIE


# === JWT 유틸 테스트 ===


class TestJwtUtils:
    """JWT 생성/검증 유틸 테스트."""

    def test_generate_and_verify_token(self):
        """정상적인 토큰 생성 및 검증."""
        user = {"email": "test@example.com", "name": "Test User", "picture": "https://example.com/pic.jpg"}
        secret = "test-secret-key"

        token = generate_token(user, secret)
        payload = verify_token(token, secret)

        assert payload is not None
        assert payload["email"] == "test@example.com"
        assert payload["name"] == "Test User"
        assert payload["picture"] == "https://example.com/pic.jpg"
        assert payload["sub"] == "test@example.com"

    def test_verify_token_wrong_secret(self):
        """잘못된 시크릿으로 검증 시 None 반환."""
        user = {"email": "test@example.com"}
        token = generate_token(user, "correct-secret")
        result = verify_token(token, "wrong-secret")
        assert result is None

    def test_verify_token_invalid_token(self):
        """유효하지 않은 토큰 검증 시 None 반환."""
        result = verify_token("invalid.token.string", "any-secret")
        assert result is None

    def test_generate_token_minimal_user(self):
        """최소 필드(email만)로 토큰 생성.

        R-2 fix(2026-05-10): picture가 user dict에 없거나 빈 문자열이면 JWT payload에
        키 자체가 박히지 않는다 (G-1 fix, atom bfdf8f2f). 키 부재 vs 빈 문자열을
        의미 분리하여 build_browser_caller_info의 truthy 필터에서 키 누락으로 흘러가던
        결함을 닫는다.
        """
        user = {"email": "min@example.com"}
        secret = "test-secret"

        token = generate_token(user, secret)
        payload = verify_token(token, secret)

        assert payload["email"] == "min@example.com"
        assert payload["name"] == ""
        # R-2: picture는 truthy일 때만 박히므로 키 자체가 없어야 한다.
        assert "picture" not in payload


# === Auth Routes 테스트 ===

# 테스트용 시크릿 (32바이트 이상 — JWT 경고 방지)
_TEST_SECRET = "test-secret-key-for-auth-routes-testing-32bytes"


def _create_test_app(
    auth_enabled: bool = False,
    is_development: bool = False,
    google_client_id: str = "",
    google_client_secret: str = "",
    callback_url: str = "/api/auth/google/callback",
    allowed_email: str = "",
    jwt_secret: str = _TEST_SECRET,
) -> FastAPI:
    """테스트용 FastAPI 앱 생성. create_oauth_router 팩토리로 라우터를 생성한다."""
    app = FastAPI()
    router = create_oauth_router(
        google_client_id=google_client_id if auth_enabled else "",
        google_client_secret=google_client_secret,
        callback_url=callback_url,
        allowed_email=allowed_email,
        jwt_secret=jwt_secret,
        is_development=is_development,
    )
    app.include_router(router)
    return app


class TestAuthConfigEndpoint:
    """GET /api/auth/config 테스트."""

    def test_auth_disabled(self):
        """GOOGLE_CLIENT_ID 미설정 시 authEnabled: false."""
        app = _create_test_app(auth_enabled=False, is_development=True)
        client = TestClient(app)
        resp = client.get("/api/auth/config")

        assert resp.status_code == 200
        data = resp.json()
        assert data["authEnabled"] is False
        assert data["devModeEnabled"] is True

    def test_auth_enabled(self):
        """GOOGLE_CLIENT_ID 설정 시 authEnabled: true."""
        app = _create_test_app(auth_enabled=True, google_client_id="test-client-id")
        client = TestClient(app)
        resp = client.get("/api/auth/config")

        assert resp.status_code == 200
        data = resp.json()
        assert data["authEnabled"] is True
        assert data["devModeEnabled"] is False


class TestAuthStatusEndpoint:
    """GET /api/auth/status 테스트."""

    def test_status_auth_disabled(self):
        """인증 비활성 시 authenticated: true."""
        app = _create_test_app(auth_enabled=False)
        client = TestClient(app)
        resp = client.get("/api/auth/status")

        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is True
        assert data["user"] is None

    def test_status_no_cookie(self):
        """인증 활성 + 쿠키 없음 → authenticated: false."""
        app = _create_test_app(auth_enabled=True, google_client_id="test-client-id")
        client = TestClient(app)
        resp = client.get("/api/auth/status")

        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is False

    def test_status_valid_cookie(self):
        """인증 활성 + 유효한 JWT 쿠키 → authenticated: true + user."""
        secret = _TEST_SECRET
        token = generate_token({"email": "user@example.com", "name": "Test"}, secret)

        app = _create_test_app(auth_enabled=True, google_client_id="test-client-id", jwt_secret=secret)
        client = TestClient(app)
        resp = client.get("/api/auth/status", cookies={COOKIE_NAME: token})

        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is True
        assert data["user"]["email"] == "user@example.com"

    def test_status_invalid_cookie(self):
        """인증 활성 + 유효하지 않은 JWT 쿠키 → authenticated: false."""
        app = _create_test_app(auth_enabled=True, google_client_id="test-client-id")
        client = TestClient(app)
        resp = client.get("/api/auth/status", cookies={COOKIE_NAME: "invalid-token"})

        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is False


class TestAuthLogoutEndpoint:
    """POST /api/auth/logout 테스트."""

    def test_logout_clears_cookie(self):
        """로그아웃 시 쿠키 삭제."""
        app = _create_test_app()
        client = TestClient(app)
        resp = client.post("/api/auth/logout")

        assert resp.status_code == 200
        assert resp.json()["success"] is True
        # 쿠키 삭제 확인 (max-age=0 또는 expires in past)
        set_cookie = resp.headers.get("set-cookie", "")
        assert COOKIE_NAME in set_cookie


class TestAuthGoogleEndpoint:
    """GET /api/auth/google 테스트."""

    def test_google_redirect_when_enabled(self):
        """인증 활성 시 Google authorize URL로 리다이렉트 + state 쿠키 설정."""
        app = _create_test_app(
            auth_enabled=True,
            google_client_id="test-client-id",
            callback_url="/api/auth/google/callback",
        )
        client = TestClient(app, follow_redirects=False)
        resp = client.get("/api/auth/google")

        assert resp.status_code == 307
        location = resp.headers["location"]
        assert "accounts.google.com" in location
        assert "test-client-id" in location
        assert "state=" in location
        # state 쿠키가 설정되었는지 확인
        set_cookie = resp.headers.get("set-cookie", "")
        assert OAUTH_STATE_COOKIE in set_cookie

    def test_google_404_when_disabled(self):
        """인증 비활성 시 404."""
        app = _create_test_app(auth_enabled=False)
        client = TestClient(app)
        resp = client.get("/api/auth/google")

        assert resp.status_code == 404


class TestDevLoginEndpoint:
    """POST /api/auth/dev-login 테스트."""

    def test_dev_login_in_development(self):
        """개발 환경에서 dev-login 동작."""
        app = _create_test_app(is_development=True)
        client = TestClient(app)
        resp = client.post(
            "/api/auth/dev-login",
            json={"email": "dev@example.com", "name": "Developer"},
        )

        assert resp.status_code == 200
        assert resp.json()["success"] is True
        # JWT 쿠키가 설정되었는지 확인
        set_cookie = resp.headers.get("set-cookie", "")
        assert COOKIE_NAME in set_cookie

    def test_dev_login_in_production(self):
        """프로덕션 환경에서 dev-login 거부."""
        app = _create_test_app(is_development=False)
        client = TestClient(app)
        resp = client.post(
            "/api/auth/dev-login",
            json={"email": "dev@example.com"},
        )

        assert resp.status_code == 403

    def test_dev_login_no_jwt_secret(self):
        """JWT_SECRET 미설정 시 500 에러."""
        app = _create_test_app(is_development=True, jwt_secret="")
        client = TestClient(app)
        resp = client.post(
            "/api/auth/dev-login",
            json={"email": "dev@example.com"},
        )

        assert resp.status_code == 500

    def test_dev_login_no_email(self):
        """이메일 없이 dev-login 시 400 에러."""
        app = _create_test_app(is_development=True)
        client = TestClient(app)
        resp = client.post(
            "/api/auth/dev-login",
            json={"email": ""},
        )

        assert resp.status_code == 400

    def test_dev_login_default_picture_when_omitted(self):
        """picture 미공급 시 deterministic identicon URL이 JWT에 박힘.

        B-5 결함 fix: dev-login이 picture를 받지도 채우지도 않아 JWT picture=""로
        영속되었고, build_browser_caller_info의 truthy filter가 avatar_url을 drop
        했다. dev 환경에서도 caller_info의 avatar_url 분기가 시험되도록 deterministic
        default URL(이메일 시드 identicon)을 generate_token 전에 채운다.
        """
        app = _create_test_app(is_development=True)
        client = TestClient(app)
        resp = client.post(
            "/api/auth/dev-login",
            json={"email": "alice@example.com", "name": "Alice"},
        )

        assert resp.status_code == 200
        # set-cookie에서 jwt 추출 → 디코드
        cookies = resp.cookies
        token = cookies.get(COOKIE_NAME)
        assert token, "dev-login set-cookie에 jwt가 없음"
        payload = verify_token(token, _TEST_SECRET)
        assert payload is not None
        # picture는 비어있지 않은 deterministic URL이어야 한다.
        assert isinstance(payload["picture"], str)
        assert len(payload["picture"]) > 0
        # email이 시드로 들어가서 결과가 달라지는지 확인 (deterministic 확인)
        assert "alice@example.com" in payload["picture"] or \
            payload["picture"].endswith("alice%40example.com") or \
            payload["picture"].endswith("alice@example.com")

    def test_dev_login_explicit_picture_preserved(self):
        """body.picture가 있으면 그 값이 그대로 JWT에 박힘 (default 덮어쓰기 금지)."""
        app = _create_test_app(is_development=True)
        client = TestClient(app)
        custom_url = "https://lh3.googleusercontent.com/a/custom-avatar.png"
        resp = client.post(
            "/api/auth/dev-login",
            json={
                "email": "bob@example.com",
                "name": "Bob",
                "picture": custom_url,
            },
        )

        assert resp.status_code == 200
        cookies = resp.cookies
        token = cookies.get(COOKIE_NAME)
        assert token
        payload = verify_token(token, _TEST_SECRET)
        assert payload is not None
        assert payload["picture"] == custom_url

    def test_dev_login_default_picture_deterministic(self):
        """같은 이메일이면 같은 default URL — backfill·캐시 안전성."""
        app = _create_test_app(is_development=True)
        client = TestClient(app)

        resp1 = client.post(
            "/api/auth/dev-login",
            json={"email": "carol@example.com"},
        )
        resp2 = client.post(
            "/api/auth/dev-login",
            json={"email": "carol@example.com"},
        )

        token1 = resp1.cookies.get(COOKIE_NAME)
        token2 = resp2.cookies.get(COOKIE_NAME)
        p1 = verify_token(token1, _TEST_SECRET)
        p2 = verify_token(token2, _TEST_SECRET)
        # picture는 deterministic — 시간/sub 무관
        assert p1["picture"] == p2["picture"]


# === require_dashboard_auth 의존성 테스트 ===


class TestRequireDashboardAuth:
    """require_dashboard_auth FastAPI 의존성 테스트."""

    def test_bypass_when_disabled(self):
        """인증 비활성 시 바이패스 (의존성이 보호하는 엔드포인트 접근)."""
        from fastapi import Depends

        app = FastAPI()

        @app.get("/protected")
        async def protected(auth=Depends(require_dashboard_auth)):
            return {"ok": True, "auth": auth}

        with patch("soul_server.dashboard.auth.get_settings") as mock_settings:
            settings = MagicMock()
            settings.is_auth_enabled = False
            mock_settings.return_value = settings

            client = TestClient(app)
            resp = client.get("/protected")

        assert resp.status_code == 200
        assert resp.json()["auth"] is None

    def test_reject_when_no_token(self):
        """인증 활성 + 토큰 없음 → 401."""
        from fastapi import Depends

        app = FastAPI()

        @app.get("/protected")
        async def protected(auth=Depends(require_dashboard_auth)):
            return {"ok": True}

        with patch("soul_server.dashboard.auth.get_settings") as mock_settings:
            settings = MagicMock()
            settings.is_auth_enabled = True
            mock_settings.return_value = settings

            client = TestClient(app)
            resp = client.get("/protected")

        assert resp.status_code == 401

    def test_accept_valid_cookie(self):
        """인증 활성 + 유효한 JWT 쿠키 → 200."""
        from fastapi import Depends

        app = FastAPI()

        @app.get("/protected")
        async def protected(auth=Depends(require_dashboard_auth)):
            return {"ok": True, "email": auth["email"]}

        secret = _TEST_SECRET
        token = generate_token({"email": "user@example.com"}, secret)

        with patch("soul_server.dashboard.auth.get_settings") as mock_settings:
            settings = MagicMock()
            settings.is_auth_enabled = True
            settings.jwt_secret = secret
            mock_settings.return_value = settings

            client = TestClient(app)
            resp = client.get("/protected", cookies={COOKIE_NAME: token})

        assert resp.status_code == 200
        assert resp.json()["email"] == "user@example.com"

    def test_accept_bearer_token(self):
        """인증 활성 + Authorization Bearer 헤더 → 200."""
        from fastapi import Depends

        app = FastAPI()

        @app.get("/protected")
        async def protected(auth=Depends(require_dashboard_auth)):
            return {"ok": True, "email": auth["email"]}

        secret = _TEST_SECRET
        token = generate_token({"email": "user@example.com"}, secret)

        with patch("soul_server.dashboard.auth.get_settings") as mock_settings:
            settings = MagicMock()
            settings.is_auth_enabled = True
            settings.jwt_secret = secret
            mock_settings.return_value = settings

            client = TestClient(app)
            resp = client.get("/protected", headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 200
        assert resp.json()["email"] == "user@example.com"
