"""Tests for /api/auth/google/native — 네이티브 앱 PKCE ID token 처리.

다른 fixture에 영향을 주지 않기 위해, 테스트 전용 mini FastAPI app을 만들어
create_native_auth_router만 마운트한 상태에서 검증한다.
"""

from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from soulstream_server.api.auth_native import create_native_auth_router


IOS_CLIENT_ID = "test-ios-client-id.apps.googleusercontent.com"
JWT_SECRET = "test-jwt-secret"


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_native_auth_router(
            google_ios_client_id=IOS_CLIENT_ID,
            jwt_secret=JWT_SECRET,
        )
    )
    return app


class TestNativeAuth:
    def test_valid_id_token_returns_jwt(self):
        """유효한 ID token → 200 + jwt body."""
        app = _make_app()
        client = TestClient(app)
        with patch(
            "soulstream_server.api.auth_native.id_token.verify_oauth2_token"
        ) as mock_verify:
            mock_verify.return_value = {
                "email": "test@example.com",
                "name": "Test User",
                "picture": "https://example.com/pic.png",
            }
            resp = client.post(
                "/api/auth/google/native",
                json={"id_token": "fake-google-id-token"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "token" in body
        assert isinstance(body["token"], str) and len(body["token"]) > 0

        # audience 검증이 iOS client ID로 수행됐는지 확인
        mock_verify.assert_called_once()
        call_kwargs = mock_verify.call_args.kwargs
        assert call_kwargs["audience"] == IOS_CLIENT_ID

    def test_invalid_id_token_returns_400(self):
        """ID token 검증 실패(ValueError) → 400."""
        app = _make_app()
        client = TestClient(app)
        with patch(
            "soulstream_server.api.auth_native.id_token.verify_oauth2_token"
        ) as mock_verify:
            mock_verify.side_effect = ValueError("Wrong issuer")
            resp = client.post(
                "/api/auth/google/native",
                json={"id_token": "bad-token"},
            )

        assert resp.status_code == 400
        assert "Invalid ID token" in resp.json()["detail"]

    def test_id_token_missing_email_returns_400(self):
        """ID token에 email 클레임이 없으면 → 400."""
        app = _make_app()
        client = TestClient(app)
        with patch(
            "soulstream_server.api.auth_native.id_token.verify_oauth2_token"
        ) as mock_verify:
            mock_verify.return_value = {"name": "No Email"}
            resp = client.post(
                "/api/auth/google/native",
                json={"id_token": "no-email-token"},
            )

        assert resp.status_code == 400
        assert "missing email" in resp.json()["detail"]

    def test_missing_id_token_field_returns_422(self):
        """body에 id_token 필드가 없으면 → 422 (pydantic 검증)."""
        app = _make_app()
        client = TestClient(app)
        resp = client.post("/api/auth/google/native", json={})
        assert resp.status_code == 422

    def test_returned_jwt_contains_user_info(self):
        """발급된 jwt를 verify_token으로 풀어 페이로드 확인."""
        from soul_common.auth.jwt import verify_token

        app = _make_app()
        client = TestClient(app)
        with patch(
            "soulstream_server.api.auth_native.id_token.verify_oauth2_token"
        ) as mock_verify:
            mock_verify.return_value = {
                "email": "alice@example.com",
                "name": "Alice",
                "picture": "https://example.com/alice.png",
            }
            resp = client.post(
                "/api/auth/google/native",
                json={"id_token": "alice-token"},
            )

        assert resp.status_code == 200
        token = resp.json()["token"]
        payload = verify_token(token, JWT_SECRET)
        assert payload is not None
        assert payload["email"] == "alice@example.com"
        assert payload["name"] == "Alice"
        assert payload["picture"] == "https://example.com/alice.png"
