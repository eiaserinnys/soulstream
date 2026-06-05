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
        for name, value in (cookies or {}).items():
            client.cookies.set(name, value)
        return client.post("/api/sessions", json=body, headers=headers or {})


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
        bad_token = generate_token({"email": "x@y.z", "name": "x"}, "wrong-secret-for-caller-info-32b")
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

    def test_jwt_partial_fields_routed_to_system(self, mock_task_manager, jwt_secret):
        """R-6 (G-22) 정정: JWT name 부재 → system 분류 (orch와 §9 대칭).

        soul-server 자체 대시보드 진입(`/api/sessions`)에 cron-jobs 같은 minimal JWT가
        들어오는 케이스는 실제 cron-jobs가 *orch에* 두드리므로 발생 가능성 낮으나, §9 대칭으로
        soul-server 측도 같은 분류 정본(resolve_caller_info_or_system) 호출.

        이전 R-5까지 expectation: cookie+email-only → browser, display_name 누락 graceful.
        R-6부터: JWT name 부재 단독 트리거 → system caller_info.
        """
        token = generate_token({"email": "minimal@example.com"}, jwt_secret)
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            cookies={COOKIE_NAME: token},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        # R-6 분류 결과: system source
        assert ci["source"] == "system"
        assert ci["display_name"] == "Soulstream"
        assert ci["avatar_url"] == "/api/system/portraits/system"
        # soul-server는 settings.soulstream_node_id 사용 — 테스트 환경에서 빈 문자열 default
        assert "agent_node" in ci
        assert ci["user_id"] is None

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


class TestDashboardCallerInfoSystemRoutingSoul:
    """R-6 (2026-05-11, G-22): soul-server 측 외부 자동 호출자 분류 — orch와 §9 대칭.

    분류 정본은 동일하게 soul_common.auth.caller_info.resolve_caller_info_or_system.
    soul-server는 system_node_id=settings.soulstream_node_id 전달.
    """

    def test_bearer_minimal_jwt_routes_to_system(self, mock_task_manager, jwt_secret):
        """T-R6-S1: Bearer JWT email-only + body.caller_info 미박음 → system 분류 (soul-server 진입)."""
        token = generate_token({"email": "cron@example.com"}, jwt_secret)
        resp = _post(
            mock_task_manager,
            {"prompt": "test"},
            headers={"Authorization": f"Bearer {token}", "user-agent": "curl/8.5.0"},
        )
        assert resp.status_code == 201

        ci = _captured_caller_info(mock_task_manager)
        assert ci["source"] == "system"
        assert ci["display_name"] == "Soulstream"
        assert ci["avatar_url"] == "/api/system/portraits/system"
        assert ci["user_id"] is None

    def test_bearer_full_jwt_preserves_browser(self, mock_task_manager, jwt_secret):
        """T-R6-S2: Bearer JWT name+picture → browser 분류 유지 (false-positive 회피)."""
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
        assert ci["source"] == "browser"
        assert ci["display_name"] == "Alice"
        assert ci["avatar_url"] == "https://x/p"
