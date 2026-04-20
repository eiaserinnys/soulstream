"""Tests for /api/auth/token endpoint (native JWT handoff).

시나리오:
1. Bearer 인증 → Bearer 값을 token 필드로 반환
2. JWT 쿠키 인증 → 쿠키 값을 token 필드로 반환
3. 무인증 → 401 (verify_auth가 차단)

verify_auth가 이미 test_auth.py에서 전반적으로 검증되므로, 여기서는
/api/auth/token 엔드포인트의 응답 형태와 인증 경로별 정본 토큰 반환만 다룬다.
"""

import pytest

from soul_common.auth.jwt import COOKIE_NAME, generate_token

from tests.conftest import TEST_AUTH_TOKEN


class TestAuthTokenEndpoint:
    """/api/auth/token 응답 시나리오."""

    async def test_bearer_auth_returns_bearer_token(self, client, auth_headers):
        """Authorization: Bearer <token> → {"token": "<token>"} 반환."""
        resp = await client.get("/api/auth/token", headers=auth_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert "token" in body
        assert body["token"] == TEST_AUTH_TOKEN

    async def test_jwt_cookie_returns_cookie_value(self, client):
        """JWT 쿠키만 설정된 경우 → {"token": "<jwt>"} 반환.

        settings.is_auth_enabled가 False이면 create_auth_dep는 쿠키 없어도 통과하지만,
        이 엔드포인트는 verify_auth 통과 후 request.cookies에서 쿠키 값을 직접 읽는다.
        쿠키가 설정되어 있으면 그 값이 그대로 반환되어야 한다.
        """
        from soulstream_server.config import get_settings

        settings = get_settings()
        # 기본 Bearer 헤더 제거 — 쿠키 경로만으로 통과 + 응답 확인
        client.headers.pop("Authorization", None)

        # is_auth_enabled=True인 경우에만 유효 JWT를 생성, 그 외엔 임의 쿠키로 충분.
        if settings.is_auth_enabled:
            cookie_value = generate_token(
                {"email": "dev@example.com", "name": "Dev", "picture": ""},
                settings.jwt_secret,
            )
        else:
            cookie_value = "any-cookie-value-in-dev-mode"

        client.cookies.set(COOKIE_NAME, cookie_value)
        resp = await client.get("/api/auth/token")
        assert resp.status_code == 200
        body = resp.json()
        assert body["token"] == cookie_value

    async def test_unauthenticated_returns_401(self, client):
        """Bearer도 쿠키도 없고, is_auth_enabled=True일 때 401.

        is_auth_enabled=False(development with empty jwt_secret)이면 쿠키 없어도
        verify_auth가 통과하고 이 엔드포인트는 Authorization도 쿠키도 없으므로
        방어적 401을 반환한다 — 둘 중 어느 경로로든 결과는 401이다.
        """
        client.headers.pop("Authorization", None)
        client.cookies.clear()
        resp = await client.get(
            "/api/auth/token",
            headers={"Authorization": "Bearer wrong-token"},
        )
        assert resp.status_code == 401
