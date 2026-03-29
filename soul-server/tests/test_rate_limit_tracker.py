"""RateLimitTracker 단위 테스트

정수 단위(floor) 기반 중복 방지 및 rate_limit_type별 독립 추적 검증.
"""

from datetime import datetime, timezone, timedelta

import pytest

from soul_server.service.rate_limit_tracker import RateLimitTracker


def _make_info(
    utilization: float,
    rate_limit_type: str = "five_hour",
    resets_at: str | None = None,
) -> dict:
    info: dict = {"utilization": utilization, "rateLimitType": rate_limit_type}
    if resets_at is not None:
        info["resetsAt"] = resets_at
    return info


class TestRateLimitTracker:
    def test_below_threshold_returns_none(self):
        """임계값(95%) 미만이면 None을 반환한다."""
        tracker = RateLimitTracker()
        result = tracker.record(_make_info(0.90))
        assert result is None

    def test_first_alert_above_threshold(self):
        """임계값 초과 첫 알림은 utilization, rate_limit_type을 포함한 dict를 반환한다."""
        tracker = RateLimitTracker()
        result = tracker.record(_make_info(0.95))
        assert result is not None
        assert result["type"] == "credential_alert"
        assert result["utilization"] == 0.95
        assert result["rate_limit_type"] == "five_hour"

    def test_same_floor_no_repeated_alert(self):
        """동일한 정수 단위(floor)에서는 두 번째 알림을 보내지 않는다."""
        tracker = RateLimitTracker()
        first = tracker.record(_make_info(0.953))
        assert first is not None  # floor=95, 첫 알림

        second = tracker.record(_make_info(0.958))
        assert second is None  # floor=95 동일 → 알림 없음

    def test_floor_increase_triggers_new_alert(self):
        """정수 단위(floor)가 증가하면 새 알림을 반환한다."""
        tracker = RateLimitTracker()
        tracker.record(_make_info(0.953))  # floor=95 알림 발송
        result = tracker.record(_make_info(0.96))  # floor=96 증가 → 새 알림
        assert result is not None
        assert result["utilization"] == 0.96

    def test_drops_below_then_re_enters_threshold(self):
        """임계값 아래로 내려갔다가 다시 초과하면 알림을 재발송한다."""
        tracker = RateLimitTracker()
        tracker.record(_make_info(0.95))  # 알림 발송
        tracker.record(_make_info(0.80))  # 임계값 아래 → floor 초기화
        result = tracker.record(_make_info(0.95))  # 재진입 → 알림
        assert result is not None

    def test_non_float_utilization_returns_none(self):
        """utilization이 숫자가 아니면 None을 반환한다."""
        tracker = RateLimitTracker()
        result = tracker.record({"utilization": "unknown", "rateLimitType": "five_hour"})
        assert result is None

    def test_auto_reset_on_expired_resets_at(self):
        """resetsAt이 과거이면 floor가 초기화되어 재진입 시 알림이 발송된다."""
        tracker = RateLimitTracker()
        tracker.record(_make_info(0.95))  # floor=95 저장

        # resetsAt이 1시간 전 — 만료됨
        expired = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        result = tracker.record(_make_info(0.95, resets_at=expired))
        # 만료로 초기화 후 재진입이므로 알림
        assert result is not None

    def test_independent_tracking_per_rate_limit_type(self):
        """rate_limit_type별로 독립적으로 추적한다."""
        tracker = RateLimitTracker()
        tracker.record(_make_info(0.95, "five_hour"))  # five_hour floor=95

        # seven_day는 별도 추적 — 첫 알림이어야 함
        result = tracker.record(_make_info(0.95, "seven_day"))
        assert result is not None
        assert result["rate_limit_type"] == "seven_day"
