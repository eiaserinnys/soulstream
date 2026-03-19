"""자동 재연결 로직.

Exponential backoff으로 WebSocket 연결을 관리한다.
연결 성공 시 backoff을 리셋하고, 실패 시 점진적으로 대기 시간을 늘린다.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


class ReconnectPolicy:
    """Exponential backoff 재연결 정책.

    Parameters:
        initial_delay: 첫 번째 재연결 대기 시간 (초)
        max_delay: 최대 재연결 대기 시간 (초)
        multiplier: backoff 배수
    """

    def __init__(
        self,
        initial_delay: float = 3.0,
        max_delay: float = 60.0,
        multiplier: float = 2.0,
    ) -> None:
        self._initial_delay = initial_delay
        self._max_delay = max_delay
        self._multiplier = multiplier
        self._current_delay = initial_delay
        self._attempt = 0

    @property
    def attempt(self) -> int:
        return self._attempt

    def reset(self) -> None:
        """연결 성공 시 호출. backoff을 초기값으로 리셋한다."""
        self._current_delay = self._initial_delay
        self._attempt = 0

    async def wait(self) -> None:
        """다음 재연결까지 대기한다."""
        self._attempt += 1
        delay = self._current_delay
        logger.info(
            "Reconnecting in %.1fs (attempt %d)",
            delay,
            self._attempt,
        )
        await asyncio.sleep(delay)
        self._current_delay = min(
            self._current_delay * self._multiplier,
            self._max_delay,
        )
