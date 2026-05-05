"""메시지 수신 루프 — 인터벤션 폴링과 메시지 처리를 병렬 실행"""

import asyncio
import logging
from collections import deque
from typing import Optional, Callable, Awaitable

from soul_server.claude.compact_retry import (
    CompactRetryHandler,
    COMPACT_RETRY_READ_TIMEOUT,
)
from soul_server.claude.message_processor import MessageProcessor
from soul_server.claude.sdk_compat import ParseAction, classify_parse_error
from soul_server.engine.types import EngineEvent, InterventionCallback, EventCallback

try:
    from claude_agent_sdk import ClaudeSDKClient
    from claude_agent_sdk._errors import MessageParseError
    from claude_agent_sdk.types import ResultMessage
except ImportError:

    class ClaudeSDKClient:
        pass

    class MessageParseError(Exception):
        pass

    class ResultMessage:
        pass


logger = logging.getLogger(__name__)

INTERVENTION_POLL_INTERVAL = 1.0  # 초: 인터벤션 폴링 주기
MAX_INTERVENTION_DRAIN = 100  # _drain_interventions 안전 상한


class ReceiveLoop:
    """메시지 수신 루프: 인터벤션 폴링과 메시지 처리를 병렬 실행

    ClaudeRunner와 동일 수명. _execute()에서 매 실행마다 run()을 호출합니다.
    """

    def __init__(
        self,
        *,
        runner_id: str,
        pending_events: deque,
        on_client_session_update: Callable[[str], None],
    ):
        self._runner_id = runner_id
        self._pending_events = pending_events
        self._on_client_session_update = on_client_session_update

    def _drain_pending_events(self) -> list[EngineEvent]:
        """pending 큐의 모든 이벤트를 반환하고 비움"""
        events = list(self._pending_events)
        self._pending_events.clear()
        return events

    async def _poll_intervention(
        self,
        client: "ClaudeSDKClient",
        on_intervention: InterventionCallback,
    ) -> bool:
        """인터벤션 큐를 한 번 폴링하고, 메시지가 있으면 주입.

        Returns:
            True if an intervention was injected, False otherwise.
        """
        try:
            intervention_text = await on_intervention()
            if intervention_text:
                logger.info(
                    f"인터벤션 주입: runner={self._runner_id}, "
                    f"text={intervention_text[:100]}..."
                )
                await client.query(intervention_text)
                return True
        except Exception as e:
            logger.warning(f"인터벤션 콜백 오류 (무시): {e}")
        return False

    async def _drain_interventions(
        self,
        client: "ClaudeSDKClient",
        on_intervention: InterventionCallback,
    ) -> int:
        """큐에 남은 인터벤션을 모두 소비.

        ResultMessage 수신 후 호출하여 아직 주입되지 못한 메시지를 처리합니다.
        세션이 이미 완료된 상태이므로 best-effort 전달입니다.
        SDK가 세션 종료로 인해 query를 거부하면 오류를 무시하고 중단합니다.

        Returns:
            Number of interventions drained.
        """
        count = 0
        while count < MAX_INTERVENTION_DRAIN:
            try:
                intervention_text = await on_intervention()
                if not intervention_text:
                    break
                logger.info(
                    f"인터벤션 드레인 주입: runner={self._runner_id}, "
                    f"text={intervention_text[:100]}..."
                )
                await client.query(intervention_text)
                count += 1
            except Exception as e:
                logger.warning(f"인터벤션 드레인 오류 (무시): {e}")
                break
        if count >= MAX_INTERVENTION_DRAIN:
            logger.warning(f"인터벤션 드레인 상한 도달: {MAX_INTERVENTION_DRAIN}건")
        elif count > 0:
            logger.info(f"인터벤션 드레인 완료: {count}건 주입")
        return count

    async def _notify_pending_subagent_events(
        self,
        on_event: Optional[EventCallback],
    ) -> None:
        """pending 큐에 있는 서브에이전트 이벤트를 on_event 콜백으로 전달"""
        if not on_event:
            return

        events = self._drain_pending_events()
        for event in events:
            try:
                await on_event(event)
            except Exception as e:
                logger.warning(f"서브에이전트 이벤트 콜백 오류: {e}")

    async def run(
        self,
        client: "ClaudeSDKClient",
        compact_handler: CompactRetryHandler,
        msg_state,
        *,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        on_compact: Optional[Callable[[str, str], Awaitable[None]]] = None,
        on_intervention: Optional[InterventionCallback] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_event: Optional[EventCallback] = None,
    ) -> None:
        """내부 메시지 수신 루프: receive_response()에서 메시지를 읽어 상태 갱신

        인터벤션 폴링은 메시지 수신과 병렬로 실행됩니다.
        Claude API 응답 대기 중에도 INTERVENTION_POLL_INTERVAL 간격으로
        on_intervention 콜백을 폴링하여 사용자 메시지를 즉시 주입합니다.
        """
        processor = MessageProcessor(
            msg_state=msg_state,
            on_event=on_event,
            on_progress=on_progress,
            on_session=on_session,
            on_client_session_update=self._on_client_session_update,
        )
        aiter = client.receive_response().__aiter__()

        # 메시지 수신 태스크를 재사용하기 위한 변수.
        # 폴링 타이머 완료 시 msg_task는 pending 상태로 재사용되며,
        # 메시지 도착 시 finally에서 None으로 리셋하여 다음 반복에서 새로 생성한다.
        msg_task: Optional[asyncio.Task] = None

        try:
            while True:
                # 메시지 수신 태스크가 없으면 새로 생성
                if msg_task is None:
                    if compact_handler.retry_count > 0:
                        msg_task = asyncio.create_task(
                            asyncio.wait_for(
                                aiter.__anext__(),
                                timeout=COMPACT_RETRY_READ_TIMEOUT,
                            )
                        )
                    else:
                        msg_task = asyncio.create_task(aiter.__anext__())

                # 인터벤션 콜백이 있고, 메시지가 아직 대기 중이면 폴링 타이머와 병렬 대기
                if on_intervention and not msg_task.done():
                    poll_timer = asyncio.create_task(
                        asyncio.sleep(INTERVENTION_POLL_INTERVAL)
                    )
                    done, _ = await asyncio.wait(
                        [msg_task, poll_timer],
                        return_when=asyncio.FIRST_COMPLETED,
                    )

                    if msg_task not in done:
                        # 타이머만 완료, 메시지 아��� 대기 중 → 인터벤션 폴링
                        await self._poll_intervention(client, on_intervention)
                        continue  # msg_task는 재사용
                    # msg_task 완료. 타이머도 완료되었으면 폴링 후 메시지 처리
                    if poll_timer in done:
                        await self._poll_intervention(client, on_intervention)
                    else:
                        poll_timer.cancel()
                        try:
                            await poll_timer
                        except asyncio.CancelledError:
                            pass

                # 메시지 수신 결과 처리
                try:
                    message = await msg_task
                except asyncio.TimeoutError:
                    logger.warning(
                        f"Compact retry 읽기 타임아웃 "
                        f"({COMPACT_RETRY_READ_TIMEOUT}s): "
                        f"runner={self._runner_id}, "
                        f"retry={compact_handler.retry_count}"
                    )
                    return
                except StopAsyncIteration:
                    return
                except MessageParseError as e:
                    action, msg_type = classify_parse_error(e.data, log_fn=logger)
                    if action is ParseAction.CONTINUE:
                        continue
                    raise
                finally:
                    # 완료된 태스크 참조 해제. 다음 반복에서 새 태스크를 생성한다.
                    msg_task = None

                # 메시지 처리를 MessageProcessor에 위임
                await processor.process(message)

                # ResultMessage 수신 후 큐에 남은 인터벤션을 best-effort로 소비
                if isinstance(message, ResultMessage) and on_intervention:
                    await self._drain_interventions(client, on_intervention)

                # 컴팩션 이벤트 알림
                await compact_handler.notify_events(on_compact)

                # 서브에이전트 이벤트 알림 (훅에서 큐에 추가된 이벤트)
                await self._notify_pending_subagent_events(on_event)

                # 메시지 수신 후에도 인터벤션 폴링 (기존 동작 유지)
                if on_intervention:
                    await self._poll_intervention(client, on_intervention)
        finally:
            # 비정상 종료(CancelledError 등) 시 대기 중인 msg_task 정리
            if msg_task is not None and not msg_task.done():
                msg_task.cancel()
                try:
                    await msg_task
                except (asyncio.CancelledError, Exception):
                    pass
