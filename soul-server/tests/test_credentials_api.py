"""
test_credentials_api - Credentials REST API 통합 테스트

FastAPI TestClient를 사용한 엔드포인트 통합 테스트.
모든 엔드포인트는 Bearer 토큰 인증이 필요하며,
conftest.py에서 제공하는 auth_headers fixture를 사용합니다.
"""

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from soul_server.service.credential_store import CredentialStore
from soul_server.service.credential_swapper import CredentialSwapper
from soul_server.service.rate_limit_tracker import RateLimitTracker
from soul_server.api.credentials import create_credentials_router


CRED_TEAM = {
    "claudeAiOauth": {
        "accessToken": "fake-team-access-token-for-testing",
        "refreshToken": "fake-team-refresh-token-for-testing",
        "expiresAt": 1770300031040,
        "scopes": ["user:inference"],
        "subscriptionType": "team",
        "rateLimitTier": "default_raven",
    }
}

CRED_MAX = {
    "claudeAiOauth": {
        "accessToken": "fake-max-access-token-for-testing",
        "refreshToken": "fake-max-refresh-token-for-testing",
        "expiresAt": 1772208817068,
        "scopes": ["user:inference"],
        "subscriptionType": "max",
        "rateLimitTier": "default_claude_max_20x",
    }
}


@pytest.fixture
def setup(tmp_path: Path, auth_headers: dict):
    """테스트용 앱, 클라이언트, store, swapper를 셋업."""
    profiles_dir = tmp_path / "profiles"
    cred_dir = tmp_path / ".claude"
    cred_dir.mkdir()
    cred_file = cred_dir / ".credentials.json"
    cred_file.write_text(json.dumps(CRED_TEAM), encoding="utf-8")

    store = CredentialStore(profiles_dir=profiles_dir)
    swapper = CredentialSwapper(store=store, credentials_path=cred_file)

    app = FastAPI()
    router = create_credentials_router(store=store, swapper=swapper)
    app.include_router(router, prefix="/profiles")

    client = TestClient(app)
    return {
        "client": client,
        "store": store,
        "swapper": swapper,
        "cred_file": cred_file,
        "profiles_dir": profiles_dir,
        "auth_headers": auth_headers,
    }


class TestListProfiles:
    def test_list_empty(self, setup):
        resp = setup["client"].get("/profiles", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["profiles"] == []
        assert data["active"] is None

    def test_list_with_profiles(self, setup):
        store = setup["store"]
        store.save("team", CRED_TEAM)
        store.save("personal", CRED_MAX)
        store.set_active("team")

        resp = setup["client"].get("/profiles", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["profiles"]) == 2
        assert data["active"] == "team"

        names = {p["name"] for p in data["profiles"]}
        assert names == {"team", "personal"}


class TestGetActive:
    def test_no_active(self, setup):
        resp = setup["client"].get("/profiles/active", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["active"] is None
        assert data["profile"] is None

    def test_with_active(self, setup):
        store = setup["store"]
        store.save("team", CRED_TEAM)
        store.set_active("team")

        resp = setup["client"].get("/profiles/active", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["active"] == "team"
        assert data["profile"]["subscriptionType"] == "team"


class TestSaveProfile:
    def test_save_current(self, setup):
        resp = setup["client"].post("/profiles/my_team", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "my_team"
        assert data["saved"] is True

        # store에 저장됐는지 확인
        profile = setup["store"].get("my_team")
        assert profile is not None
        assert profile["claudeAiOauth"]["subscriptionType"] == "team"

    def test_save_invalid_name(self, setup):
        # '../' 는 FastAPI 라우터가 정규화하므로, 선두 언더스코어로 테스트
        resp = setup["client"].post("/profiles/_hidden", headers=setup["auth_headers"])
        assert resp.status_code == 400

    def test_save_reserved_name(self, setup):
        resp = setup["client"].post("/profiles/_active", headers=setup["auth_headers"])
        assert resp.status_code == 400


class TestActivateProfile:
    def test_activate_existing(self, setup):
        store = setup["store"]
        store.save("max_profile", CRED_MAX)

        resp = setup["client"].post(
            "/profiles/max_profile/activate", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["activated"] == "max_profile"

        # 크레덴셜이 실제로 교체됐는지 확인
        current = json.loads(setup["cred_file"].read_text(encoding="utf-8"))
        assert current["claudeAiOauth"]["subscriptionType"] == "max"

    def test_activate_nonexistent(self, setup):
        resp = setup["client"].post(
            "/profiles/nonexistent/activate", headers=setup["auth_headers"]
        )
        assert resp.status_code == 404

    def test_activate_invalid_name(self, setup):
        resp = setup["client"].post(
            "/profiles/_bad/activate", headers=setup["auth_headers"]
        )
        assert resp.status_code == 400


class TestDeleteProfile:
    def test_delete_existing(self, setup):
        setup["store"].save("to_delete", CRED_TEAM)

        resp = setup["client"].delete(
            "/profiles/to_delete", headers=setup["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["deleted"] is True

    def test_delete_nonexistent(self, setup):
        resp = setup["client"].delete("/profiles/ghost", headers=setup["auth_headers"])
        assert resp.status_code == 404

    def test_delete_invalid_name(self, setup):
        resp = setup["client"].delete("/profiles/_bad", headers=setup["auth_headers"])
        assert resp.status_code == 400


# === Rate Limits API 테스트 ===


@pytest.fixture
def setup_with_tracker(tmp_path: Path, auth_headers: dict):
    """rate_limit_tracker를 포함한 테스트 셋업."""
    profiles_dir = tmp_path / "profiles"
    cred_dir = tmp_path / ".claude"
    cred_dir.mkdir()
    cred_file = cred_dir / ".credentials.json"
    cred_file.write_text(json.dumps(CRED_TEAM), encoding="utf-8")

    store = CredentialStore(profiles_dir=profiles_dir)
    swapper = CredentialSwapper(store=store, credentials_path=cred_file)
    tracker = RateLimitTracker(
        store=store, state_path=profiles_dir / "_rate_limits.json"
    )

    app = FastAPI()
    router = create_credentials_router(
        store=store, swapper=swapper, rate_limit_tracker=tracker
    )
    app.include_router(router, prefix="/profiles")

    client = TestClient(app)
    return {
        "client": client,
        "store": store,
        "tracker": tracker,
        "auth_headers": auth_headers,
    }


class TestGetAllRateLimits:
    def test_empty_profiles(self, setup_with_tracker):
        resp = setup_with_tracker["client"].get(
            "/profiles/rate-limits", headers=setup_with_tracker["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["profiles"] == []
        assert data["active_profile"] is None

    def test_with_tracked_data(self, setup_with_tracker):
        store = setup_with_tracker["store"]
        tracker = setup_with_tracker["tracker"]

        store.save("linegames", CRED_TEAM)
        store.set_active("linegames")
        tracker.record(
            {
                "rateLimitType": "five_hour",
                "utilization": 0.42,
                "resetsAt": (
                    datetime.now(timezone.utc) + timedelta(hours=5)
                ).isoformat(),
            }
        )

        resp = setup_with_tracker["client"].get(
            "/profiles/rate-limits", headers=setup_with_tracker["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["active_profile"] == "linegames"
        assert len(data["profiles"]) >= 1

        lg = next(p for p in data["profiles"] if p["name"] == "linegames")
        assert lg["five_hour"]["utilization"] == 0.42


class TestGetProfileRateLimits:
    def test_unknown_profile(self, setup_with_tracker):
        resp = setup_with_tracker["client"].get(
            "/profiles/unknown/rate-limits", headers=setup_with_tracker["auth_headers"]
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "unknown"
        assert data["five_hour"]["utilization"] == "unknown"
        assert data["seven_day"]["utilization"] == "unknown"

    def test_tracked_profile(self, setup_with_tracker):
        store = setup_with_tracker["store"]
        tracker = setup_with_tracker["tracker"]

        store.save("linegames", CRED_TEAM)
        store.set_active("linegames")
        tracker.record(
            {
                "rateLimitType": "five_hour",
                "utilization": 0.55,
                "resetsAt": (
                    datetime.now(timezone.utc) + timedelta(hours=5)
                ).isoformat(),
            }
        )

        resp = setup_with_tracker["client"].get(
            "/profiles/linegames/rate-limits",
            headers=setup_with_tracker["auth_headers"],
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "linegames"
        assert data["five_hour"]["utilization"] == 0.55


class TestRateLimitsWithoutTracker:
    """tracker가 없을 때 503 반환 테스트."""

    def test_no_tracker_returns_503(self, setup):
        resp = setup["client"].get(
            "/profiles/rate-limits", headers=setup["auth_headers"]
        )
        assert resp.status_code == 503


class TestGetCurrentEmail:
    def test_email_not_found_returns_null(self, setup):
        """이메일 필드가 없으면 available=False 반환"""
        # CRED_TEAM에는 email 필드가 없으므로
        resp = setup["client"].get("/profiles/email", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] is None
        assert data["available"] is False

    def test_email_found_in_oauth(self, setup):
        """claudeAiOauth.email 필드가 있으면 반환"""
        cred_with_email = {
            "claudeAiOauth": {
                **CRED_TEAM["claudeAiOauth"],
                "email": "user@example.com",
            }
        }
        setup["cred_file"].write_text(json.dumps(cred_with_email), encoding="utf-8")

        resp = setup["client"].get("/profiles/email", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "user@example.com"
        assert data["available"] is True

    def test_email_found_at_top_level(self, setup):
        """최상위 email 필드가 있으면 반환"""
        cred_with_email = {
            **CRED_TEAM,
            "email": "top@example.com",
        }
        setup["cred_file"].write_text(json.dumps(cred_with_email), encoding="utf-8")

        resp = setup["client"].get("/profiles/email", headers=setup["auth_headers"])
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "top@example.com"
        assert data["available"] is True

    def test_no_auth_returns_401(self, setup):
        """인증 없으면 401"""
        resp = setup["client"].get("/profiles/email")
        assert resp.status_code == 401

    def test_credentials_file_missing(self, setup):
        """크레덴셜 파일 없으면 404"""
        setup["cred_file"].unlink()

        resp = setup["client"].get("/profiles/email", headers=setup["auth_headers"])
        assert resp.status_code == 404


class TestAuthenticationRequired:
    """인증 없이 요청 시 401 반환 테스트."""

    def test_no_auth_returns_401(self, setup):
        resp = setup["client"].get("/profiles")
        assert resp.status_code == 401

    def test_invalid_token_returns_401(self, setup):
        resp = setup["client"].get(
            "/profiles", headers={"Authorization": "Bearer invalid-token"}
        )
        assert resp.status_code == 401

    def test_malformed_auth_header_returns_401(self, setup):
        resp = setup["client"].get("/profiles", headers={"Authorization": "Basic abc"})
        assert resp.status_code == 401
