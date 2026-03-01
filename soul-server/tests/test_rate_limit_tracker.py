"""
test_rate_limit_tracker - RateLimitTracker 단위 테스트

프로필별 rate limit 추적, 자동 리셋, 95% 알림, 상태 영속화.
"""

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

from soul_server.service.credential_store import CredentialStore
from soul_server.service.rate_limit_tracker import RateLimitTracker


@pytest.fixture
def store_dir(tmp_path: Path) -> Path:
    """임시 프로필 저장 디렉토리."""
    return tmp_path / "profiles"


@pytest.fixture
def store(store_dir: Path) -> CredentialStore:
    """테스트용 CredentialStore 인스턴스."""
    return CredentialStore(profiles_dir=store_dir)


@pytest.fixture
def state_path(tmp_path: Path) -> Path:
    """상태 파일 경로."""
    return tmp_path / "profiles" / "_rate_limits.json"


@pytest.fixture
def tracker(store: CredentialStore, state_path: Path) -> RateLimitTracker:
    """테스트용 RateLimitTracker 인스턴스."""
    return RateLimitTracker(store=store, state_path=state_path)


def _setup_active_profile(store: CredentialStore, name: str = "linegames") -> None:
    """활성 프로필 설정 헬퍼."""
    store.save(name, {
        "claudeAiOauth": {
            "accessToken": "fake-token",
            "subscriptionType": "team",
            "rateLimitTier": "default_raven",
        }
    })
    store.set_active(name)


# === 기본 기록 테스트 ===

class TestRecord:
    """record() 메서드 테스트."""

    def test_record_stores_utilization(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """rate limit 이벤트를 기록하면 프로필 상태에 반영된다."""
        _setup_active_profile(store)

        resets_at = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
        tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.42,
            "resetsAt": resets_at,
            "status": "allowed_warning",
        })

        status = tracker.get_profile_status("linegames")
        assert status["five_hour"]["utilization"] == 0.42
        assert status["five_hour"]["resets_at"] == resets_at

    def test_record_updates_both_types(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """five_hour와 seven_day 모두 개별 추적된다."""
        _setup_active_profile(store)

        tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.30,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })
        tracker.record({
            "rateLimitType": "seven_day",
            "utilization": 0.51,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        })

        status = tracker.get_profile_status("linegames")
        assert status["five_hour"]["utilization"] == 0.30
        assert status["seven_day"]["utilization"] == 0.51

    def test_record_no_active_profile_returns_none(
        self, tracker: RateLimitTracker
    ):
        """활성 프로필이 없으면 None 반환."""
        result = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.50,
        })
        assert result is None

    def test_record_unknown_type_stored(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """알 수 없는 rate limit 타입도 기록된다."""
        _setup_active_profile(store)

        tracker.record({
            "rateLimitType": "unknown_type",
            "utilization": 0.10,
        })

        status = tracker.get_profile_status("linegames")
        assert "unknown_type" in status


# === 95% 알림 트리거 테스트 ===

class TestAlertTrigger:
    """95% 알림 트리거 로직 테스트."""

    def test_alert_at_95_percent(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """utilization >= 0.95일 때 알림 반환."""
        _setup_active_profile(store)

        result = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.95,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })

        assert result is not None
        assert result["type"] == "credential_alert"
        assert result["active_profile"] == "linegames"
        assert isinstance(result["profiles"], list)

    def test_no_alert_below_95(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """utilization < 0.95이면 알림 없음."""
        _setup_active_profile(store)

        result = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.94,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })

        assert result is None

    def test_alert_dedup(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """같은 타입에 대해 95% 알림은 한 번만 발생."""
        _setup_active_profile(store)

        info = {
            "rateLimitType": "five_hour",
            "utilization": 0.96,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        }

        result1 = tracker.record(info)
        result2 = tracker.record({**info, "utilization": 0.97})

        assert result1 is not None
        assert result2 is None

    def test_alert_dedup_per_type(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """five_hour와 seven_day는 각각 독립적으로 알림."""
        _setup_active_profile(store)

        result_5h = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.95,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })
        result_7d = tracker.record({
            "rateLimitType": "seven_day",
            "utilization": 0.96,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        })

        assert result_5h is not None
        assert result_7d is not None

    def test_alert_contains_all_profiles(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """알림에는 모든 프로필의 상태가 포함된다."""
        _setup_active_profile(store, "linegames")
        # 두 번째 프로필 추가
        store.save("personal", {
            "claudeAiOauth": {
                "accessToken": "fake-token-2",
                "subscriptionType": "individual",
            }
        })

        result = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.95,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })

        assert result is not None
        profile_names = [p["name"] for p in result["profiles"]]
        assert "linegames" in profile_names
        assert "personal" in profile_names


# === 자동 리셋 테스트 ===

class TestAutoReset:
    """resetsAt 시간 경과 시 자동 0% 처리."""

    def test_expired_resets_to_zero(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """resetsAt이 과거이면 utilization = 0, alerted_95 초기화."""
        _setup_active_profile(store)

        # 과거 시간으로 설정
        past_time = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.95,
            "resetsAt": past_time,
        })

        status = tracker.get_profile_status("linegames")
        assert status["five_hour"]["utilization"] == 0.0
        assert status["five_hour"]["resets_at"] is None

    def test_reset_clears_alerted_flag(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """리셋 후 95% 알림 플래그도 초기화되어 재알림 가능."""
        _setup_active_profile(store)

        # 1차: 95% 알림 발생
        future_time = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
        result1 = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.95,
            "resetsAt": future_time,
        })
        assert result1 is not None

        # 수동으로 resets_at을 과거로 변경하여 리셋 시뮬레이션
        tracker._force_reset("linegames", "five_hour")

        # 2차: 리셋 후 다시 95% → 재알림
        result2 = tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.96,
            "resetsAt": future_time,
        })
        assert result2 is not None


# === 상태 영속화 테스트 ===

class TestPersistence:
    """JSON 파일 영속화 테스트."""

    def test_state_persisted_to_file(
        self, tracker: RateLimitTracker, store: CredentialStore, state_path: Path
    ):
        """record() 후 상태가 파일에 저장된다."""
        _setup_active_profile(store)

        tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.42,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })

        assert state_path.is_file()
        data = json.loads(state_path.read_text(encoding="utf-8"))
        assert "linegames" in data
        assert data["linegames"]["five_hour"]["utilization"] == 0.42

    def test_state_restored_on_init(
        self, store: CredentialStore, state_path: Path
    ):
        """재시작 시 파일에서 상태를 복원한다."""
        _setup_active_profile(store)

        # 상태 파일 직접 생성
        state_path.parent.mkdir(parents=True, exist_ok=True)
        future_time = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
        state_data = {
            "linegames": {
                "five_hour": {
                    "utilization": 0.80,
                    "resets_at": future_time,
                    "alerted_95": False,
                }
            }
        }
        state_path.write_text(
            json.dumps(state_data, ensure_ascii=False), encoding="utf-8"
        )

        # 새 tracker 인스턴스 생성 → 복원
        tracker2 = RateLimitTracker(store=store, state_path=state_path)
        status = tracker2.get_profile_status("linegames")
        assert status["five_hour"]["utilization"] == 0.80

    def test_corrupted_state_file_handled(
        self, store: CredentialStore, state_path: Path
    ):
        """손상된 상태 파일은 무시하고 빈 상태로 시작."""
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text("NOT VALID JSON!!!", encoding="utf-8")

        tracker = RateLimitTracker(store=store, state_path=state_path)
        status = tracker.get_all_profiles_status()
        assert status == []


# === 프로필 상태 조회 테스트 ===

class TestStatusQuery:
    """프로필 상태 조회 테스트."""

    def test_get_profile_status_unknown(
        self, tracker: RateLimitTracker
    ):
        """기록이 없는 프로필은 unknown 상태."""
        status = tracker.get_profile_status("nonexistent")
        assert status["five_hour"]["utilization"] == "unknown"
        assert status["seven_day"]["utilization"] == "unknown"

    def test_get_all_profiles_status(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """모든 프로필의 상태를 반환한다."""
        _setup_active_profile(store, "linegames")
        store.save("personal", {
            "claudeAiOauth": {"accessToken": "fake-2"}
        })

        tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.42,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })

        statuses = tracker.get_all_profiles_status()
        assert len(statuses) >= 2
        names = [s["name"] for s in statuses]
        assert "linegames" in names
        assert "personal" in names

        lg = next(s for s in statuses if s["name"] == "linegames")
        assert lg["five_hour"]["utilization"] == 0.42

        personal = next(s for s in statuses if s["name"] == "personal")
        assert personal["five_hour"]["utilization"] == "unknown"

    def test_get_profile_status_format(
        self, tracker: RateLimitTracker, store: CredentialStore
    ):
        """프로필 상태의 형식이 올바른지 확인."""
        _setup_active_profile(store)

        tracker.record({
            "rateLimitType": "five_hour",
            "utilization": 0.50,
            "resetsAt": (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat(),
        })

        status = tracker.get_profile_status("linegames")
        assert "five_hour" in status
        assert "seven_day" in status
        assert "utilization" in status["five_hour"]
        assert "resets_at" in status["five_hour"]
