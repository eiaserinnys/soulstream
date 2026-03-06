"""Compact retry 핸들러 — CompactRetryState + 판정 로직 분리

ClaudeRunner._evaluate_compact_retry()와 CompactRetryState를
독립 모듈로 분리한다. 판정만 수행하고, 실제 retry 루프는
ClaudeRunner에 남는다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Awaitable, Callable, Optional

if TYPE_CHECKING:
    from soul_server.claude.agent_runner import MessageState

logger = logging.getLogger(__name__)

# Compact retry 상수
COMPACT_RETRY_READ_TIMEOUT = 30  # 초: retry 시 receive_response() 읽기 타임아웃
MAX_COMPACT_RETRIES = 3  # compact 재시도 최대 횟수


@dataclass
class CompactRetryState:
    """Compact retry 외부 루프 상태"""

    events: list[dict] = field(default_factory=list)
    notified_count: int = 0
    retry_count: int = 0

    def snapshot(self) -> int:
        """현재 이벤트 수 기록 (외부 루프 시작 시 호출)"""
        return len(self.events)

    def did_compact(self, before: int) -> bool:
        """스냅샷 이후 compact가 발생했는지"""
        return len(self.events) > before

    def can_retry(self, max_retries: int = MAX_COMPACT_RETRIES) -> bool:
        return self.retry_count < max_retries

    def increment(self) -> None:
        self.retry_count += 1


def _extract_last_assistant_text(collected_messages: list[dict]) -> str:
    """collected_messages에서 마지막 assistant 텍스트를 추출 (tool_use 제외)"""
    for msg in reversed(collected_messages):
        if msg.get("role") == "assistant" and not msg.get(
            "content", ""
        ).startswith("[tool_use:"):
            return msg["content"]
    return ""


class CompactRetryHandler:
    """Compact retry 판정 로직

    ClaudeRunner._evaluate_compact_retry()에서 분리.
    판정만 수행하고, 실제 retry 루프는 ClaudeRunner에 남는다.
    """

    def __init__(self, max_retries: int = MAX_COMPACT_RETRIES):
        self.state = CompactRetryState()
        self.max_retries = max_retries

    @property
    def events(self) -> list[dict]:
        """compact 이벤트 리스트 (PreCompact 훅이 추가)"""
        return self.state.events

    @property
    def retry_count(self) -> int:
        return self.state.retry_count

    def snapshot(self) -> int:
        """현재 이벤트 수 기록"""
        return self.state.snapshot()

    def evaluate(
        self,
        msg_state: MessageState,
        before_snapshot: int,
        cli_alive: bool,
        pid: Optional[int],
        runner_id: str,
    ) -> bool:
        """Compact retry 판정. True이면 재시도, False이면 종료.

        Side effect: CLI 종료 시 collected_messages에서 fallback 텍스트 복원.
        """
        compact_happened = self.state.did_compact(before_snapshot)

        if not compact_happened:
            return False

        if msg_state.has_result:
            logger.info(
                f"Compact 발생했으나 이미 유효한 결과 있음 - retry 생략 "
                f"(result_text={len(msg_state.result_text)} chars, "
                f"current_text={len(msg_state.current_text)} chars, "
                f"compact_retry_count={self.state.retry_count}/{self.max_retries})"
            )
            return False

        if not self.state.can_retry(self.max_retries):
            return False

        # CLI 프로세스 상태 확인
        logger.info(
            f"Compact retry 판정: pid={pid}, cli_alive={cli_alive}, "
            f"has_result={msg_state.has_result}, "
            f"current_text={len(msg_state.current_text)} chars, "
            f"result_text={len(msg_state.result_text)} chars, "
            f"collected_msgs={len(msg_state.collected_messages)}, "
            f"retry={self.state.retry_count}/{self.max_retries}"
        )

        if not cli_alive:
            # CLI 종료: collected_messages에서 마지막 텍스트 복원
            logger.warning(
                f"Compact retry 생략: CLI 프로세스 이미 종료 "
                f"(pid={pid}, runner={runner_id})"
            )
            fallback_text = _extract_last_assistant_text(
                msg_state.collected_messages
            )
            if fallback_text:
                msg_state.current_text = fallback_text
                logger.info(
                    f"Fallback: collected_messages에서 텍스트 복원 "
                    f"({len(fallback_text)} chars)"
                )
            return False

        self.state.increment()
        logger.info(
            f"Compact 후 응답 재수신 시도 "
            f"(retry={self.state.retry_count}/{self.max_retries}, "
            f"session_id={msg_state.session_id})"
        )
        return True

    async def notify_events(
        self,
        on_compact: Optional[Callable[[str, str], Awaitable[None]]],
    ) -> None:
        """미통지 compact 이벤트를 on_compact 콜백으로 전달"""
        if not on_compact:
            return
        pending = self.state.events[self.state.notified_count :]
        if not pending:
            return
        for event in pending:
            try:
                await on_compact(event["trigger"], event["message"])
            except Exception as e:
                logger.warning(f"컴팩션 콜백 오류: {e}")
        self.state.notified_count = len(self.state.events)
