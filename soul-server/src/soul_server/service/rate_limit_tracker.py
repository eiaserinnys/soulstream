"""
RateLimitTracker - rate limit 상태 추적 및 알림

rate limit 타입별 사용량을 추적하고, 95% 임계값 도달 시 알림을 트리거합니다.
정수 단위(floor)가 증가할 때만 재알림하여 중복 알림을 방지합니다.
"""

import logging
import threading
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# 알림 임계값
_ALERT_THRESHOLD = 0.95


class RateLimitTracker:
    """rate limit 상태 추적기.

    thread-safe: record()는 내부 Lock으로 보호됩니다.

    정수 단위(floor) 기반 중복 방지:
    - utilization * 100의 정수 값이 증가할 때만 알림을 발송합니다.
    - 예: 72.3% → 72.8% = 알림 없음 (둘 다 72)
    - 예: 72% → 73% = 알림 발송
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # rate_limit_type → last alerted integer % (floor of utilization * 100)
        self._last_alerted_floor: dict[str, int] = {}

    def record(self, rate_limit_info: dict) -> Optional[dict]:
        """rate limit 이벤트를 기록한다.

        95% 임계값 초과 시, 정수 단위가 증가한 경우에만 알림 딕셔너리를 반환합니다.

        Args:
            rate_limit_info: rate_limit_event에서 추출한 정보
                - rateLimitType: "five_hour" | "seven_day" 등
                - utilization: 0~1 float
                - resetsAt: ISO timestamp (optional)

        Returns:
            credential_alert 딕셔너리 (알림 조건 충족 시) 또는 None
        """
        utilization = rate_limit_info.get("utilization")
        rate_limit_type = rate_limit_info.get("rateLimitType", "unknown")
        resets_at = rate_limit_info.get("resetsAt")

        if not isinstance(utilization, (int, float)):
            return None

        with self._lock:
            if resets_at:
                self._check_auto_reset(rate_limit_type, resets_at)

            if utilization >= _ALERT_THRESHOLD:
                current_floor = int(utilization * 100)
                last_floor = self._last_alerted_floor.get(rate_limit_type)
                if last_floor is None or current_floor > last_floor:
                    self._last_alerted_floor[rate_limit_type] = current_floor
                    logger.info(
                        f"사용량 알림 트리거: type={rate_limit_type}, "
                        f"utilization={utilization:.1%} (floor={current_floor})"
                    )
                    return self._build_alert(utilization, rate_limit_type)
            else:
                # 임계값 아래로 내려오면 floor 초기화 (재진입 시 알림 허용)
                self._last_alerted_floor.pop(rate_limit_type, None)

        return None

    def _build_alert(self, utilization: float, rate_limit_type: str) -> dict:
        """credential_alert 이벤트 딕셔너리 구성."""
        return {
            "type": "credential_alert",
            "utilization": utilization,
            "rate_limit_type": rate_limit_type,
        }

    def _check_auto_reset(self, rate_limit_type: str, resets_at: str) -> None:
        """resetsAt이 과거이면 해당 타입의 floor를 초기화.

        새 시그니처: (rate_limit_type, resets_at)
        이전 시그니처는 (profile, rate_type, type_state)였으며 CredentialStore에 의존했음.
        """
        try:
            reset_time = datetime.fromisoformat(resets_at.replace("Z", "+00:00"))
            if datetime.now(timezone.utc) >= reset_time:
                self._last_alerted_floor.pop(rate_limit_type, None)
                logger.info(f"rate limit 윈도우 만료로 알림 상태 초기화: type={rate_limit_type}")
        except (ValueError, AttributeError):
            pass
