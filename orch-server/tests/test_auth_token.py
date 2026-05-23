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

    async def test_jwt_cookie_returns_cookie_value(self, client, monkeypatch):
        """JWT 쿠키만 설정된 경우 → {"token": "<jwt>"} 반환.

        F-9 fix(2026-05-08, side-fix): 이전엔 `is_auth_enabled=False` 환경에서
        verify_auth가 무조건 통과하는 결함을 우회하여 임의 쿠키로 통과시켰다.
        결함이 닫히면서 본 테스트는 `google_client_id`·`jwt_secret`을 monkeypatch로
        설정하여 `is_auth_enabled=True`를 강제하고 실제 유효 JWT 쿠키 검증을 시험한다.
        """
        from soulstream_server.config import get_settings

        settings = get_settings()
        # is_auth_enabled를 True로 만들기 위해 settings 필드 직접 패치 (테스트 종료 시 복구).
        monkeypatch.setattr(settings, "google_client_id", "fake-client-id-for-test")
        monkeypatch.setattr(
            settings,
            "jwt_secret",
            "test-jwt-secret-at-least-32-bytes-long",
        )

        # 기본 Bearer 헤더 제거 — 쿠키 경로만으로 통과 + 응답 확인
        client.headers.pop("Authorization", None)

        cookie_value = generate_token(
            {"email": "dev@example.com", "name": "Dev", "picture": ""},
            settings.jwt_secret,
        )
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
