"""test_dashboard_get_sessions - dashboard /api/sessions user 프로필 fallback 통합 테스트.

R-3 fix(2026-05-08): GET /api/sessions가 caller_info 정체성을 무시하고
settings.dash_user_name으로 모든 행을 일괄 덮어쓰던 결함을 닫는다.

본 테스트는 dashboard 라우트가 다음 정책을 따르는지 검증:
- caller_info가 채운 userName/userPortraitUrl은 보존 (mix-fallback 금지)
- caller_info 부재 시에만 settings.dash_user_name으로 fallback (graceful)

orch `apply_user_profile_enrichment`와 동일 의미의 정책 (정본 둘 안티패턴 회피).
"""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _build_test_app():
    """dashboard 라우터를 mount한 테스트 FastAPI 앱."""
    from soul_server.dashboard.routes.sessions import router

    app = FastAPI()
    # require_dashboard_auth는 dependency override로 우회 — 테스트 단순화.
    from soul_server.dashboard.auth import require_dashboard_auth

    app.dependency_overrides[require_dashboard_auth] = lambda: None
    app.include_router(router)
    return app


def _patch_settings(user_name: str = "DashUser", user_portrait: str = ""):
    """get_settings를 mock하여 dash_user_name/dash_user_portrait를 주입."""
    settings = MagicMock()
    settings.dash_user_name = user_name
    settings.dash_user_portrait = user_portrait
    return patch("soul_server.config.get_settings", return_value=settings)


def _patch_query_service(sessions, total=None):
    """get_session_query_service를 mock하여 미리 만든 sessions를 반환."""
    query_svc = MagicMock()
    query_svc.get_all_sessions = AsyncMock(
        return_value=(sessions, total if total is not None else len(sessions))
    )
    return patch(
        "soul_server.dashboard.routes.sessions._query.get_session_query_service",
        return_value=query_svc,
    )


def _patch_task_manager():
    return patch(
        "soul_server.dashboard.routes.sessions._query.get_task_manager",
        return_value=MagicMock(),
    )


class TestDashboardGetSessionsUserProfile:
    """GET /api/sessions의 user 프로필 채움 정책 검증."""

    def test_caller_info_userName_preserved_against_settings(self):
        """caller_info가 채운 userName은 settings로 덮이지 않는다 (mix-fallback 금지)."""
        # _build_session_dict가 caller_info를 추출하여 채워준 결과를 흉내낸다
        sessions = [
            {
                "agent_session_id": "s1",
                "status": "running",
                "userName": "Alice",
                "userPortraitUrl": "https://avatars.slack.com/u123",
            }
        ]
        app = _build_test_app()
        with (
            _patch_settings(user_name="DashUser", user_portrait="/portrait.png"),
            _patch_query_service(sessions),
            _patch_task_manager(),
        ):
            client = TestClient(app)
            resp = client.get("/api/sessions")

        assert resp.status_code == 200
        data = resp.json()
        sess = data["sessions"][0]
        # caller_info 정체성 보존
        assert sess["userName"] == "Alice"
        assert sess["userPortraitUrl"] == "https://avatars.slack.com/u123"

    def test_caller_info_absent_falls_back_to_settings(self):
        """caller_info 없음 → settings.dash_user_name/portrait로 fallback."""
        sessions = [
            {
                "agent_session_id": "s2",
                "status": "running",
                "userName": None,
                "userPortraitUrl": None,
            }
        ]
        app = _build_test_app()
        with (
            _patch_settings(user_name="DashUser", user_portrait="/portrait.png"),
            _patch_query_service(sessions),
            _patch_task_manager(),
        ):
            client = TestClient(app)
            resp = client.get("/api/sessions")

        assert resp.status_code == 200
        sess = resp.json()["sessions"][0]
        assert sess["userName"] == "DashUser"
        assert sess["userPortraitUrl"] == "/api/dashboard/portrait/user"

    def test_caller_info_partial_userPortraitUrl_only_preserved(self):
        """userPortraitUrl만 caller_info로 채움 → settings로 덮지 않음 (mix-fallback 금지)."""
        sessions = [
            {
                "agent_session_id": "s3",
                "status": "running",
                "userName": None,
                "userPortraitUrl": "https://avatars.slack.com/u789",
            }
        ]
        app = _build_test_app()
        with (
            _patch_settings(user_name="DashUser", user_portrait="/portrait.png"),
            _patch_query_service(sessions),
            _patch_task_manager(),
        ):
            client = TestClient(app)
            resp = client.get("/api/sessions")

        sess = resp.json()["sessions"][0]
        # 정체성 부분이라도 있으면 보존
        assert sess["userName"] is None
        assert sess["userPortraitUrl"] == "https://avatars.slack.com/u789"

    def test_settings_dash_user_portrait_empty_no_portrait_url(self):
        """settings.dash_user_portrait가 빈 문자열 → portrait_url None."""
        sessions = [
            {
                "agent_session_id": "s4",
                "status": "running",
                "userName": None,
                "userPortraitUrl": None,
            }
        ]
        app = _build_test_app()
        with (
            _patch_settings(user_name="DashUser", user_portrait=""),  # portrait 미설정
            _patch_query_service(sessions),
            _patch_task_manager(),
        ):
            client = TestClient(app)
            resp = client.get("/api/sessions")

        sess = resp.json()["sessions"][0]
        assert sess["userName"] == "DashUser"
        assert sess["userPortraitUrl"] is None

    def test_mixed_sessions_each_row_independently(self):
        """여러 세션이 섞여 있을 때 각 행이 독립적으로 정책 적용."""
        sessions = [
            # caller_info 채움 — 보존
            {"agent_session_id": "s1", "status": "running",
             "userName": "Alice", "userPortraitUrl": "https://x/a"},
            # 부재 — settings fallback
            {"agent_session_id": "s2", "status": "running",
             "userName": None, "userPortraitUrl": None},
        ]
        app = _build_test_app()
        with (
            _patch_settings(user_name="DashUser", user_portrait="/p.png"),
            _patch_query_service(sessions),
            _patch_task_manager(),
        ):
            client = TestClient(app)
            resp = client.get("/api/sessions")

        sessions_resp = resp.json()["sessions"]
        s1 = next(s for s in sessions_resp if s["agent_session_id"] == "s1")
        s2 = next(s for s in sessions_resp if s["agent_session_id"] == "s2")
        assert s1["userName"] == "Alice"
        assert s1["userPortraitUrl"] == "https://x/a"
        assert s2["userName"] == "DashUser"
        assert s2["userPortraitUrl"] == "/api/dashboard/portrait/user"
