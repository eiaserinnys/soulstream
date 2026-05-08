"""
test_dashboard_create_session_caller_info — POST /api/sessions(dashboard)에서 caller_info 자동 조립 검증.

방안 B (2026-05-07 결정): cookie/Bearer JWT가 있으면 build_browser_caller_info가
user payload를 디코드하여 display_name/user_id/avatar_url/email을 caller_info에 자동 첨부한다.
body.caller_info가 있으면 그대로 우선 사용 (슬랙·RN·위임 케이스).

orch-server tests/test_create_session_caller_info.py와 대칭 케이스 (정본 하나, 두 서버 동일 동작).

검증 케이스:
1. cookie JWT 있고 body.caller_info 없음 → display_name/user_id/avatar_url/email 자동 첨부
2. body.caller_info 있음 → JWT 무시, body 값 그대로
3. JWT 디코드 실패(위조/만료) → base caller_info(IP/UA)만, 신원 필드 없음
4. JWT 부분 필드(name/picture 누락) → 빈 값 키 누락 (graceful)
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_common.auth.jwt import COOKIE_NAME, generate_token


# 테스트 격리용 JWT secret — fixture jwt_secret을 통해 settings에 주입.
# conftest에 환경변수로 박지 않는 이유: 다른 auth 테스트와의 격리 보장 (orch-server와 대칭).
_TEST_JWT_SECRET = "test-jwt-secret-for-caller-info-32b!"


@pytest.fixture
def jwt_secret(monkeypatch) -> str:
    """build_browser_caller_info의 JWT 분기를 활성화하기 위해 settings.jwt_secret 주입."""
    from soul_server.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "jwt_secret", _TEST_JWT_SECRET)
    return _TEST_JWT_SECRET


@pytest.fixture
def mock_task_manager():
    tm = MagicMock()
    task = MagicMock()
    task.agent_session_id = "sess-created"
    tm.create_task = AsyncMock(return_value=task)
    tm.executor.start_execution = AsyncMock()
    return tm


def _build_app():
    from soul_server.dashboard.api_router import router
    from soul_server.dashboard.auth import require_dashboard_auth

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_dashboard_auth] = lambda: None
    return app


def _post(mock_task_manager, body: dict, cookies: dict | None = None, headers: dict | None = None):
    """공통 POST helper — task_manager·resource_manager·soul_engine을 mock 처리."""
    app = _build_app()
    with (
        patch("soul_server.dashboard.routes.sessions._lifecycle.get_task_manager", return_value=mock_task_manager),
        patch("soul_server.dashboard.routes.sessions._lifecycle.resource_manager") as mock_rm,
        patch("soul_server.dashboard.routes.sessions._lifecycle.get_soul_engine", return_value=MagicMock()),
    ):
        mock_rm.can_acquire.return_value = True
        client = TestClient(app, raise_server_exceptions=True)
        return client.post("/api/sessions", json=body, cookies=cookies or {}, headers=headers or {})


def _captured_caller_info(mock_task_manager):
    """create_task에 전달된 CreateTaskParams의 caller_info를 추출."""
    args = mock_task_manager.create_task.call_args.args
    return args[0].caller_info


class TestDashboardCreateSessionCallerInfoJwtAutoFill:
    """방안 B: dashboard create_session이 cookie JWT에서 user 정보를 자동 첨부한다."""

    def test_jwt_cookie_populates_caller_info_when_body_missing(self, mock_task_manager, jwt_secret):
        """body.caller_info 없고 cookie JWT 있으면 display_name/user_id/avatar_url/email 자동 첨부."""
        token = generate_token(
            {
                "email": "user@example.com",
                "name": "서소영",
                "picture": "https://lh3.googleusercontent.com/avatar.png",
            },
            jwt_secret,
        )
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci["source"] == "browser"
        assert ci["display_name"] == "서소영"
        assert ci["user_id"] == "user@example.com"
        assert ci["avatar_url"] == "https://lh3.googleusercontent.com/avatar.png"
        assert ci["email"] == "user@example.com"
        assert "user_agent" in ci  # base 메타 그대로

    def test_jwt_bearer_header_also_populates(self, mock_task_manager, jwt_secret):
        """Authorization Bearer 헤더로도 동일하게 user 정보가 채워진다."""
        token = generate_token(
            {"email": "alice@example.com", "name": "Alice", "picture": "https://x/p"},
            jwt_secret,
        )
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci["display_name"] == "Alice"
        assert ci["user_id"] == "alice@example.com"

    def test_jwt_cookie_ignored_when_body_caller_info_present(self, mock_task_manager, jwt_secret):
        """body.caller_info가 있으면 JWT 자동 첨부는 발동하지 않는다."""
        token = generate_token(
            {"email": "should-not@example.com", "name": "Should Not"},
            jwt_secret,
        )
        supplied = {"source": "agent", "agent_node": "n1", "agent_id": "a1"}
        resp = _post(
            mock_task_manager,
            {"prompt": "test", "caller_info": supplied},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci == supplied
        assert "display_name" not in ci

    def test_jwt_decode_failure_falls_back_to_base(self, mock_task_manager, jwt_secret):
        """위조 JWT는 verify 실패 → base caller_info만 (신원 필드 없음)."""
        bad_token = generate_token({"email": "x@y.z", "name": "x"}, "wrong-secret")
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            cookies={COOKIE_NAME: bad_token},
            headers={"user-agent": "TestUA"},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci["source"] == "browser"
        assert ci["user_agent"] == "TestUA"
        assert "display_name" not in ci
        assert "user_id" not in ci
        assert "email" not in ci

    def test_jwt_partial_fields_graceful(self, mock_task_manager, jwt_secret):
        """JWT에 name/picture 없어도 email/user_id만 채워지고 누락 필드는 dict에서 제외."""
        token = generate_token({"email": "minimal@example.com"}, jwt_secret)
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci["user_id"] == "minimal@example.com"
        assert ci["email"] == "minimal@example.com"
        assert "display_name" not in ci
        assert "avatar_url" not in ci

    def test_no_jwt_no_body_falls_back_to_http_meta(self, mock_task_manager):
        """JWT 없고 body.caller_info도 없으면 source='browser' + IP/UA만 채워진다 (기존 회귀)."""
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            headers={
                "user-agent": "Mozilla/5.0 TestBrowser",
                "referer": "https://dashboard.example/",
            },
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci["source"] == "browser"
        assert ci["user_agent"] == "Mozilla/5.0 TestBrowser"
        assert ci["referer"] == "https://dashboard.example/"
        assert "display_name" not in ci
