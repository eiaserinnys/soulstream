"""Tests for orch-server 이중 인증 가드 (Bearer OR JWT 쿠키).

대상 엔드포인트: `/api/status` — verify_auth로 보호 유지되는 정상 엔드포인트.
(`/api/health`는 공개로 전환되어 더 이상 이중 인증 가드 시나리오 대상이 아니다.
 공개 상태 회귀 검증은 test_api_public_routes.py에서 수행한다.)

7개 시나리오:
1. Bearer 정상 토큰 → 200
2. Authorization 헤더 누락 → 401 UNAUTHORIZED
3. 잘못된 스킴 (Basic) → 401
4. 잘못된 토큰 값 → 401
5. 유효 JWT 쿠키만 설정 → 200
6. Bearer와 JWT 둘 다 무효 → 401
7. /api/auth/config (OAuth 라우터) → 헤더 없이 접근 가능 (면제 확인)
"""

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from soul_common.auth.jwt import COOKIE_NAME, generate_token

from tests.conftest import TEST_AUTH_TOKEN


def _make_jwt_cookie(secret: str, email: str = "dev@example.com") -> str:
    """유효 JWT 쿠키 값을 생성한다."""
    return generate_token({"email": email, "name": "Dev", "picture": ""}, secret)


def _make_request(
    *,
    authorization: str | None = None,
    cookie: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if authorization is not None:
        headers.append((b"authorization", authorization.encode()))
    if cookie is not None:
        headers.append((b"cookie", cookie.encode()))
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/status",
        "headers": headers,
    })


class TestBearerAuth:
    """Bearer 토큰 인증 시나리오 (/api/status 대상)."""

    async def test_valid_bearer_token_returns_200(self, client, auth_headers):
        """정상 Bearer 토큰 → 200 (/api/status)."""
        resp = await client.get("/api/status", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["healthy"] is True

    async def test_missing_authorization_header_returns_401(self, client):
        """Authorization 헤더 누락 → 401 UNAUTHORIZED."""
        # conftest의 client는 기본 Bearer 헤더를 포함하므로 명시적으로 제거한다.
        client.headers.pop("Authorization", None)
        resp = await client.get("/api/status")
        assert resp.status_code == 401
        # HTTPException의 detail 구조: {"detail": {"error": {"code": "UNAUTHORIZED", ...}}}
        # 또는 Bearer/JWT 이중 실패 시 Bearer 쪽 에러가 올라온다.
        body = resp.json()
        assert "detail" in body

    async def test_wrong_scheme_returns_401(self, client):
        """Bearer가 아닌 스킴(Basic) → 401."""
        # 기본 Bearer 헤더를 제거하고 Basic 스킴으로 교체한다.
        client.headers.pop("Authorization", None)
        resp = await client.get(
            "/api/status",
            headers={"Authorization": "Basic some-base64-value"},
        )
        assert resp.status_code == 401

    async def test_invalid_token_returns_401(self, client):
        """잘못된 Bearer 토큰 값 → 401."""
        # 기본 헤더를 제거하고 잘못된 토큰으로 교체한다.
        client.headers.pop("Authorization", None)
        resp = await client.get(
            "/api/status",
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert resp.status_code == 401


class TestAuthModeMarkers:
    """verify_auth가 인증 경로를 request.state에 명시한다."""

    async def test_service_token_success_sets_service_token_auth_mode(self):
        from soulstream_server.api.auth import verify_auth

        authorization = f"Bearer {TEST_AUTH_TOKEN}"
        request = _make_request(authorization=authorization)

        await verify_auth(request, authorization=authorization)

        assert request.state.auth_mode == "service_token"
        assert not hasattr(request.state, "auth_user")

    async def test_jwt_success_sets_auth_user_and_jwt_auth_mode(self, monkeypatch):
        from soulstream_server.api.auth import verify_auth
        from soulstream_server.config import get_settings

        settings = get_settings()
        monkeypatch.setattr(settings, "google_client_id", "fake-client-id-for-test")
        monkeypatch.setattr(
            settings,
            "jwt_secret",
            "test-jwt-secret-at-least-32-bytes-long",
        )
        cookie_value = _make_jwt_cookie(settings.jwt_secret, "jwt-user@example.com")
        request = _make_request(cookie=f"{COOKIE_NAME}={cookie_value}")

        await verify_auth(request, authorization=None)

        assert request.state.auth_mode == "jwt"
        assert request.state.auth_user["email"] == "jwt-user@example.com"


class TestJWTCookieAuth:
    """JWT 쿠키 인증 시나리오 (/api/status 대상)."""

    async def test_valid_jwt_cookie_returns_200(self, client, monkeypatch):
        """유효 JWT 쿠키만 있고 Bearer 없음 → 200.

        F-9 fix(2026-05-08, side-fix): 이전엔 `is_auth_enabled=False`인 dev 환경에서
        `create_auth_dep`가 인증을 무조건 통과시키는 결함을 *반대로* 이용해 통과했다.
        그 결함이 닫히면서, JWT 쿠키 경로의 *실제 검증*을 시험하도록 본 테스트는
        `google_client_id`를 monkeypatch로 임시 설정하여 `is_auth_enabled=True`를
        강제하고, jwt_secret과 함께 유효 쿠키를 발급해 검증 성공을 단언한다.
        """
        from soulstream_server.config import get_settings

        # is_auth_enabled를 True로 만들기 위해 google_client_id·jwt_secret을 주입.
        # lru_cache된 settings 객체의 필드를 monkeypatch로 직접 수정하고,
        # 테스트 종료 시 자동 복구된다 (monkeypatch 책임).
        settings = get_settings()
        monkeypatch.setattr(settings, "google_client_id", "fake-client-id-for-test")
        monkeypatch.setattr(
            settings,
            "jwt_secret",
            "test-jwt-secret-at-least-32-bytes-long",
        )

        # 기본 Bearer 헤더 제거 — "JWT 쿠키 경로만으로 통과" 시나리오.
        client.headers.pop("Authorization", None)

        cookie_value = _make_jwt_cookie(settings.jwt_secret)
        client.cookies.set(COOKIE_NAME, cookie_value)

        resp = await client.get("/api/status")
        assert resp.status_code == 200

    async def test_both_bearer_and_jwt_invalid_returns_401(self, client):
        """Bearer와 JWT 둘 다 무효 → 401."""
        # 기본 Bearer 헤더를 제거하고 무효 토큰으로 교체한다.
        client.headers.pop("Authorization", None)
        client.cookies.set(COOKIE_NAME, "invalid-jwt-value")
        resp = await client.get(
            "/api/status",
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert resp.status_code == 401


class TestOAuthRouteExemption:
    """OAuth 라우터 (/api/auth/*) 면제 확인."""

    async def test_auth_config_accessible_without_auth(self, client):
        """/api/auth/config는 인증 없이 접근 가능해야 한다.

        OAuth 라우터는 로그인 자체가 인증 전 단계이므로 면제된다.
        """
        from soulstream_server.config import get_settings

        settings = get_settings()

        resp = await client.get("/api/auth/config")

        if settings.is_auth_enabled:
            # auth 라우터가 마운트되어 있으면 200 반환
            assert resp.status_code == 200
            assert "authEnabled" in resp.json()
        else:
            # auth 비활성화 상태(jwt_secret 등 미설정)면 라우터가 마운트되지 않아 404
            # 이 경우에도 "401은 아니어야 한다"는 면제 조건을 만족한다.
            assert resp.status_code != 401


class TestProductionConfigError:
    """프로덕션 환경에서 AUTH_BEARER_TOKEN 미설정 시 CONFIG_ERROR."""

    async def test_production_missing_token_returns_500(self, monkeypatch):
        """is_production=True이고 auth_bearer_token이 빈 값이면 500 CONFIG_ERROR."""
        from soulstream_server.api.auth import verify_token
        from soulstream_server.config import Settings, get_settings
        from fastapi import HTTPException

        # get_settings 캐시에 프로덕션 + 빈 토큰 Settings 주입
        fake_settings = Settings(
            host="0.0.0.0",
            port=5200,
            database_url="postgresql://test:test@localhost:5432/test",
            environment="production",
            auth_bearer_token="",
        )
        monkeypatch.setattr(
            "soulstream_server.api.auth.get_settings",
            lambda: fake_settings,
        )

        with pytest.raises(HTTPException) as exc_info:
            await verify_token(authorization=None)

        assert exc_info.value.status_code == 500
        detail = exc_info.value.detail
        assert detail["error"]["code"] == "CONFIG_ERROR"
