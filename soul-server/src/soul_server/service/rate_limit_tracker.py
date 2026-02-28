"""
RateLimitTracker - 프로필별 rate limit 상태 추적

프로필별 five_hour / seven_day rate limit 사용량을 추적하고,
95% 임계값 도달 시 알림을 트리거합니다.
상태는 JSON 파일로 영속화되어 재시작 후에도 복원됩니다.
"""

import json
import logging
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from soul_server.service.credential_store import CredentialStore

logger = logging.getLogger(__name__)

# 알림 임계값
_ALERT_THRESHOLD = 0.95

# 기본 rate limit 타입
_DEFAULT_TYPES = ("five_hour", "seven_day")

# unknown 상태를 나타내는 기본 타입 상태
_UNKNOWN_TYPE_STATE: dict[str, Any] = {
    "utilization": "unknown",
    "resets_at": None,
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(ts: Optional[str]) -> Optional[datetime]:
    """ISO 타임스탬프 파싱. 실패 시 None."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


class RateLimitTracker:
    """프로필별 rate limit 상태 추적기.

    thread-safe: record()와 상태 조회 메서드는 내부 Lock으로 보호됩니다.

    Args:
        store: 프로필 저장소 (활성 프로필 조회용)
        state_path: 상태 영속화 파일 경로
    """

    def __init__(self, store: CredentialStore, state_path: Path | str) -> None:
        self._store = store
        self._state_path = Path(state_path)
        self._lock = threading.Lock()
        self._state: dict[str, dict[str, Any]] = self._load_state()

    def _load_state(self) -> dict[str, dict[str, Any]]:
        """파일에서 상태 복원."""
        if not self._state_path.is_file():
            return {}
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
            logger.warning("상태 파일 형식 오류, 빈 상태로 시작")
            return {}
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"상태 파일 로드 실패: {e}, 빈 상태로 시작")
            return {}

    def _save_state(self) -> None:
        """상태를 파일에 저장. 호출자가 _lock을 보유한 상태에서 호출해야 합니다."""
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(
                dir=self._state_path.parent, suffix=".tmp"
            )
            try:
                import os
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump(self._state, f, ensure_ascii=False, indent=2)
                Path(tmp_name).replace(self._state_path)
            except Exception:
                Path(tmp_name).unlink(missing_ok=True)
                raise
        except OSError as e:
            logger.error(f"상태 저장 실패: {e}")

    def record(self, rate_limit_info: dict) -> Optional[dict]:
        """rate limit 이벤트를 기록한다.

        현재 활성 프로필에 대해 rate limit 정보를 기록하고,
        95% 임계값을 처음 넘으면 알림 딕셔너리를 반환합니다.

        Args:
            rate_limit_info: rate_limit_event에서 추출한 정보
                - rateLimitType: "five_hour" | "seven_day" 등
                - utilization: 0~1 float
                - resetsAt: ISO timestamp (optional)

        Returns:
            credential_alert 딕셔너리 (95% 초과 시) 또는 None
        """
        active = self._store.get_active()
        if not active:
            return None

        rate_type = rate_limit_info.get("rateLimitType", "")
        utilization = rate_limit_info.get("utilization")
        resets_at = rate_limit_info.get("resetsAt")

        if not rate_type:
            return None

        # utilization이 숫자가 아니면 기록하지 않음
        if not isinstance(utilization, (int, float)):
            return None

        with self._lock:
            # 프로필/타입별 상태 초기화
            profile_state = self._state.setdefault(active, {})
            type_state = profile_state.setdefault(rate_type, {
                "utilization": 0.0,
                "resets_at": None,
                "alerted_95": False,
            })

            # 이전 윈도우 만료 체크 (새 값 쓰기 전에 수행)
            self._check_auto_reset(active, rate_type, type_state)

            # 상태 업데이트
            type_state["utilization"] = utilization
            type_state["resets_at"] = resets_at

            # 95% 알림 트리거
            alert = None
            if utilization >= _ALERT_THRESHOLD and not type_state.get("alerted_95"):
                type_state["alerted_95"] = True
                logger.info(
                    f"95% 알림 트리거: profile={active}, type={rate_type}, "
                    f"utilization={utilization}"
                )
                alert = self._build_alert(active)

            self._save_state()
            return alert

    def _check_auto_reset(
        self, profile: str, rate_type: str, type_state: dict
    ) -> bool:
        """resetsAt이 과거이면 상태를 자동 리셋.

        Returns:
            True if reset was performed.
        """
        resets_at = _parse_iso(type_state.get("resets_at"))
        if resets_at and resets_at <= _now_utc():
            type_state["utilization"] = 0.0
            type_state["resets_at"] = None
            type_state["alerted_95"] = False
            logger.info(f"자동 리셋: profile={profile}, type={rate_type}")
            return True
        return False

    def _force_reset(self, profile: str, rate_type: str) -> None:
        """테스트용: 특정 프로필/타입의 상태를 강제 리셋."""
        with self._lock:
            profile_state = self._state.get(profile, {})
            type_state = profile_state.get(rate_type)
            if type_state:
                type_state["utilization"] = 0.0
                type_state["resets_at"] = None
                type_state["alerted_95"] = False
                self._save_state()

    def _build_alert(self, active_profile: str) -> dict:
        """credential_alert 이벤트 딕셔너리 구성."""
        return {
            "type": "credential_alert",
            "active_profile": active_profile,
            "profiles": self._get_all_profiles_status_unlocked(),
        }

    def get_profile_status(self, name: str) -> dict[str, Any]:
        """특정 프로필의 rate limit 상태 조회.

        Args:
            name: 프로필 이름

        Returns:
            {"five_hour": {...}, "seven_day": {...}} 형식
        """
        with self._lock:
            return self._get_profile_status_unlocked(name)

    def _get_profile_status_unlocked(self, name: str) -> dict[str, Any]:
        """Lock 없이 프로필 상태 조회 (Lock 보유 상태에서 호출)."""
        profile_state = self._state.get(name, {})
        result: dict[str, Any] = {}
        mutated = False

        for rate_type in _DEFAULT_TYPES:
            type_state = profile_state.get(rate_type)
            if type_state is None:
                result[rate_type] = dict(_UNKNOWN_TYPE_STATE)
            else:
                if self._check_auto_reset(name, rate_type, type_state):
                    mutated = True
                result[rate_type] = {
                    "utilization": type_state.get("utilization", "unknown"),
                    "resets_at": type_state.get("resets_at"),
                }

        # 기본 타입 외 추가 타입도 포함
        for rate_type, type_state in profile_state.items():
            if rate_type not in _DEFAULT_TYPES:
                if self._check_auto_reset(name, rate_type, type_state):
                    mutated = True
                result[rate_type] = {
                    "utilization": type_state.get("utilization", "unknown"),
                    "resets_at": type_state.get("resets_at"),
                }

        if mutated:
            self._save_state()

        return result

    def get_all_profiles_status(self) -> list[dict[str, Any]]:
        """모든 프로필의 rate limit 상태 조회.

        CredentialStore에 등록된 모든 프로필의 상태를 반환합니다.
        기록이 없는 프로필은 "unknown" 상태로 표시됩니다.

        Returns:
            [{"name": "...", "five_hour": {...}, "seven_day": {...}}, ...]
        """
        with self._lock:
            return self._get_all_profiles_status_unlocked()

    def _get_all_profiles_status_unlocked(self) -> list[dict[str, Any]]:
        """Lock 없이 전체 프로필 상태 조회 (Lock 보유 상태에서 호출)."""
        profiles = self._store.list_profiles()

        result = []
        for p in profiles:
            name = p["name"]
            status = self._get_profile_status_unlocked(name)
            status["name"] = name
            result.append(status)

        # CredentialStore에 없지만 rate limit 기록이 있는 프로필도 포함
        tracked_names = {p["name"] for p in profiles}
        for name in self._state:
            if name not in tracked_names:
                status = self._get_profile_status_unlocked(name)
                status["name"] = name
                result.append(status)

        return result
