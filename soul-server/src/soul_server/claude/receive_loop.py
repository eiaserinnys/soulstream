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
PROMPT_SUGGESTION_DRAIN_TIMEOUT = 2.0  # 초: ResultMessage 후 prompt_suggestion 추가 수신 대기.
# TS SDK 0.2.x 타입 명시: prompt_suggestion은 result 이후 도착하므로 stream을 계속 iterate해야
# 받을 수 있다. receive_response()가 result에서 즉시 return하던 한계를 우회하기 위해
# receive_messages()로 stream을 유지하고 ResultMessage 처리 후 짧은 timeout으로 1메시지를
# best-effort로 추가 수신한다. PromptSuggestionMessage가 도착하면 처리, 그 외 타입은
# logger.warning 후 무시 (drain phase는 그 이름대로 prompt_suggestion 전용 — design-principles
# §1 작은 인터페이스 / §5 제어의 단일 경로). timeout/StopAsyncIteration도 정상 종료.


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

    async def _drain_after_result(
        self,
        aiter,
        processor: MessageProcessor,
    ) -> None:
        """ResultMessage 처리 후 prompt_suggestion best-effort 추가 수신.

        TS SDK 0.2.x 타입 정의대로 prompt_suggestion은 result 이후 도착하므로,
        receive_messages stream에서 PROMPT_SUGGESTION_DRAIN_TIMEOUT 동안 1메시지를
        기다린다.

        **타입 좁히기 정책**: drain phase는 prompt_suggestion 전용. 받은 메시지가
        PromptSuggestionMessage면 processor에 위임하여 EngineEvent로 변환. 그 외
        타입은 (예: compact 후 새 응답 첫 메시지) `logger.warning` 후 무시 — drain
        phase의 이름과 동작을 일치시키고 has_result-차단으로 인한 부분 처리의 비대칭을
        제거한다 (design-principles §1 작은 인터페이스 / §5 제어의 단일 경로).
        외부 compact retry 루프가 has_result=False면 재진입하여 후속 메시지를 받는다.

        timeout 만료 / StopAsyncIteration / MessageParseError(CONTINUE) 모두
        조용히 종료한다 — drain 실패가 핵심 기능을 막지 않는다 (실패 격리 §8).
        """
        extra_task = asyncio.create_task(aiter.__anext__())
        try:
            try:
                extra_msg = await asyncio.wait_for(
                    extra_task, timeout=PROMPT_SUGGESTION_DRAIN_TIMEOUT,
                )
            except asyncio.TimeoutError:
                # prompt_suggestion 미도착 — 정상 케이스 (cache_cold suppress 등)
                logger.debug(
                    f"prompt_suggestion drain timeout ({PROMPT_SUGGESTION_DRAIN_TIMEOUT}s) "
                    f"runner={self._runner_id}"
                )
                return
            except StopAsyncIteration:
                return
            except MessageParseError as e:
                action, _ = classify_parse_error(e.data, log_fn=logger)
                if action is ParseAction.CONTINUE:
                    return
                raise
        finally:
            # task가 아직 살아있으면 정리. extra_msg 도착 후엔 이미 done이라 cancel 무해.
            if not extra_task.done():
                extra_task.cancel()
                try:
                    await extra_task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.debug(
                        f"drain task cleanup 예외 (무시) runner={self._runner_id}: {e}"
                    )

        # 타입 좁히기 — PromptSuggestionMessage만 처리, 그 외는 무시.
        from soul_server.claude.sdk_patches import PromptSuggestionMessage
        if isinstance(extra_msg, PromptSuggestionMessage):
            await processor.process(extra_msg)
        else:
            logger.warning(
                f"drain phase에서 예상 외 메시지 수신 (무시) "
                f"runner={self._runner_id}, type={type(extra_msg).__name__}"
            )

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
        """내부 메시지 수신 루프: receive_messages()에서 메시지를 읽어 상태 갱신

        인터벤션 폴링은 메시지 수신과 병렬로 실행됩니다.
        Claude API 응답 대기 중에도 INTERVENTION_POLL_INTERVAL 간격으로
        on_intervention 콜백을 폴링하여 사용자 메시지를 즉시 주입합니다.

        receive_response() 대신 receive_messages()를 사용하는 이유:
        TS SDK 0.2.x 타입 정의가 명시 — "prompt_suggestion arrives after the
        result message. Consumers must keep iterating the stream after result
        to receive it." receive_response()는 ResultMessage에서 즉시 return하여
        prompt_suggestion을 절대 받지 못한다. receive_messages()로 stream을 유지하고
        ResultMessage 처리 후 짧은 drain phase에서 1메시지 추가 수신 → 명시적 return.
        외부 compact retry 루프(agent_runner)가 evaluate로 재진입 여부 결정.
        """
        processor = MessageProcessor(
            msg_state=msg_state,
            on_event=on_event,
            on_progress=on_progress,
            on_session=on_session,
            on_client_session_update=self._on_client_session_update,
        )
        aiter = client.receive_messages().__aiter__()

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

                # ResultMessage 수신 후 인터벤션 drain + prompt_suggestion drain → 명시적 종료
                if isinstance(message, ResultMessage):
                    if on_intervention:
                        await self._drain_interventions(client, on_intervention)
                    # prompt_suggestion drain — best-effort로 1메시지 추가 수신.
                    # PromptSuggestionMessage가 도착하면 처리, 아니면 timeout/EOS로 종료.
                    # compact 발생 시 새 응답 첫 메시지가 들어올 수도 있는데, 그건 처리 후
                    # return하면 외부 compact retry 루프가 재진입하여 후속 메시지를 받는다.
                    await self._drain_after_result(aiter, processor)
                    return  # 명시적 종료 — outer compact retry가 evaluate

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
