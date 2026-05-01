"""AskUserQuestion 응답 핸들러

SDK의 can_use_tool 콜백에서 AskUserQuestion을 가로채어
외부 응답을 대기하고 SDK에 전달하는 모듈.

ClaudeRunner는 이 모듈의 InputRequestHandler를 컴포지션으로 사용한다.
"""

import asyncio
import logging
import time
import uuid as _uuid
from typing import Callable, Optional

try:
    from claude_agent_sdk.types import (
        PermissionResultAllow,
        PermissionResultDeny,
    )
except ImportError:
    class PermissionResultAllow:
        pass
    class PermissionResultDeny:
        def __init__(self, message=""):
            self.message = message

from soul_server.engine.types import (
    EventCallback,
    InputRequestEngineEvent,
    InputRequestExpiredEngineEvent,
    InputRequestRespondedEngineEvent,
)

logger = logging.getLogger(__name__)


class InputRequestHandler:
    """AskUserQuestion 요청/응답 관리

    can_use_tool 콜백 팩토리와 외부 응답 수신을 담당한다.
    ClaudeRunner가 인스턴스를 생성하여 컴포지션으로 사용한다.
    """

    def __init__(self, timeout: float = 300.0) -> None:
        self.timeout = timeout
        # request_id → asyncio.Event (응답 도착 알림)
        self._response_events: dict[str, asyncio.Event] = {}
        # request_id → 응답 데이터 (answers dict)
        self._responses: dict[str, dict] = {}
        # can_use_tool 콜백에서 직접 이벤트를 발행하기 위한 런타임 콜백
        self._on_event_callback: Optional[EventCallback] = None
        # _make_can_use_tool에서 이벤트 큐 fallback으로 사용
        self._pending_events_append: Optional[Callable[..., None]] = None

    def bind_event_callback(self, on_event: Optional[EventCallback]) -> None:
        """실행 시작 시 on_event 콜백을 바인딩"""
        self._on_event_callback = on_event

    def unbind_event_callback(self) -> None:
        """실행 종료 시 on_event 콜백 해제"""
        self._on_event_callback = None

    def bind_pending_events(self, append_fn: Callable[..., None]) -> None:
        """pending_events deque의 append 함수를 바인딩 (큐 fallback용)"""
        self._pending_events_append = append_fn

    def clear(self) -> None:
        """잔여 상태 정리 (실행 시작/종료 시)"""
        # 미응답 요청의 대기 Event를 깨워서 타임아웃 처리
        for evt in self._response_events.values():
            evt.set()
        self._response_events.clear()
        self._responses.clear()

    def deliver_response(self, request_id: str, answers: dict) -> bool:
        """외부에서 AskUserQuestion 응답을 전달

        Args:
            request_id: input_request 이벤트의 request_id
            answers: 질문별 응답 dict

        Returns:
            True: 대기 중인 요청이 있어 응답 전달 성공
            False: 대기 중인 요청 없음
        """
        event = self._response_events.get(request_id)
        if event is None:
            return False
        self._responses[request_id] = answers
        event.set()
        return True

    def make_can_use_tool(self, runner_id: str):
        """AskUserQuestion을 감지하는 can_use_tool 콜백 팩토리

        AskUserQuestion 외의 도구는 항상 허용합니다
        (permission_mode=bypassPermissions와 동등한 동작).

        AskUserQuestion이 감지되면:
        1. InputRequestEngineEvent를 _on_event_callback으로 직접 발행
        2. asyncio.Event로 클라이언트 응답을 대기
        3. 응답을 PermissionResultAllow로 변환하여 반환

        NOTE: can_use_tool 콜백은 SDK 내부의 Query._handle_control_request()에서
        호출됩니다. 이 동안 receive_messages() 스트림은 대기 상태이므로,
        _pending_events가 아닌 _on_event_callback으로 직접 이벤트를 발행해야 합니다.
        """
        timeout = self.timeout

        async def can_use_tool(tool_name, tool_input, context):
            if tool_name != "AskUserQuestion":
                return PermissionResultAllow()

            request_id = _uuid.uuid4().hex[:12]
            questions = tool_input.get("questions", [])

            logger.info(
                f"[ASK_USER] AskUserQuestion 감지: "
                f"runner={runner_id}, request_id={request_id}, "
                f"questions={len(questions)}"
            )

            # InputRequestEngineEvent를 직접 발행
            started_at = time.time()
            event = InputRequestEngineEvent(
                request_id=request_id,
                tool_use_id="",
                questions=questions,
                started_at=started_at,
                timeout_sec=timeout,
            )
            if self._on_event_callback:
                try:
                    await self._on_event_callback(event)
                except Exception as e:
                    logger.warning(f"[ASK_USER] 이벤트 발행 실패: {e}")
            else:
                logger.warning(
                    f"[ASK_USER] on_event 콜백 없음, 이벤트 큐에 추가: "
                    f"request_id={request_id}"
                )
                if self._pending_events_append:
                    self._pending_events_append(event)

            # 응답 대기용 Event 생성
            response_event = asyncio.Event()
            self._response_events[request_id] = response_event

            try:
                # 응답 대기 (타임아웃 포함)
                try:
                    await asyncio.wait_for(
                        response_event.wait(),
                        timeout=timeout,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        f"[ASK_USER] 응답 타임아웃: "
                        f"runner={runner_id}, request_id={request_id}"
                    )
                    # 만료 이벤트 발행 — 클라이언트가 선택 창을 닫도록.
                    # parent_event_id는 SSE 모델에서 Optional[int]이므로 hex request_id를 넣지 않는다.
                    # (이전 결함: parent_event_id=request_id로 SSE 발행이 영구 실패했음)
                    expired_event = InputRequestExpiredEngineEvent(
                        request_id=request_id,
                        parent_event_id=None,
                    )
                    if self._on_event_callback:
                        try:
                            await self._on_event_callback(expired_event)
                        except Exception as e:
                            logger.warning(f"[ASK_USER] 만료 이벤트 발행 실패: {e}")
                    return PermissionResultDeny(
                        message="사용자 응답 대기 시간이 초과되었습니다."
                    )

                # 응답 수신
                answers = self._responses.get(request_id, {})
                logger.info(
                    f"[ASK_USER] 응답 수신: "
                    f"runner={runner_id}, request_id={request_id}, "
                    f"answers={answers}"
                )

                # 응답 완료 이벤트 발행 — 클라이언트가 배너를 닫도록.
                # parent_event_id는 SSE 모델에서 Optional[int]이므로 hex request_id를 넣지 않는다.
                responded_event = InputRequestRespondedEngineEvent(
                    request_id=request_id,
                    parent_event_id=None,
                )
                if self._on_event_callback:
                    try:
                        await self._on_event_callback(responded_event)
                    except Exception as e:
                        logger.warning(f"[ASK_USER] 응답 완료 이벤트 발행 실패: {e}")

                # updated_input 구성: 원본 questions + answers
                updated_input = dict(tool_input)
                updated_input["answers"] = answers

                return PermissionResultAllow(updated_input=updated_input)
            finally:
                # 정리
                self._response_events.pop(request_id, None)
                self._responses.pop(request_id, None)

        return can_use_tool
