"""soul 엔진 어댑터

ClaudeRunner를 soul API용으로 래핑합니다.
ClaudeRunner.run()의 콜백(on_progress, on_compact, on_intervention)을
asyncio.Queue를 통해 SSE 이벤트 스트림으로 변환하여
기존 soul 스트리밍 인터페이스와 호환합니다.

Serendipity 연동:
  세션 시작/종료 및 SSE 이벤트를 SerendipityAdapter를 통해
  세렌디피티 블록으로 변환하여 저장합니다.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable, List, Optional

from soul_server.claude.agent_runner import ClaudeRunner
from soul_server.engine.types import EngineEvent, EngineEventType
from soul_server.config import get_settings

if TYPE_CHECKING:
    from soul_server.service.runner_pool import RunnerPool
    from soul_server.service.serendipity_adapter import SerendipityAdapter, SessionContext
from soul_server.models import (
    CompactEvent,
    CompleteEvent,
    ContextUsageEvent,
    CredentialAlertEvent,
    DebugEvent,
    ErrorEvent,
    InterventionSentEvent,
    ProgressEvent,
    RateLimitProfileInfo,
    RateLimitProfileStatus,
    ResultSSEEvent,
    SessionEvent,
    SubagentStartSSEEvent,
    SubagentStopSSEEvent,
    TextDeltaSSEEvent,
    TextEndSSEEvent,
    TextStartSSEEvent,
    ThinkingSSEEvent,
    ToolResultSSEEvent,
    ToolStartSSEEvent,
)

logger = logging.getLogger(__name__)

DEFAULT_DISALLOWED_TOOLS = ["NotebookEdit", "TodoWrite"]

# 컨텍스트 관련 상수
DEFAULT_MAX_CONTEXT_TOKENS = 200_000

# sentinel: 스트리밍 종료 신호
_DONE = object()


class _CardTracker:
    """SSE 이벤트용 카드 ID 관리 + text↔tool 관계 추적

    AssistantMessage의 TextBlock 하나를 '카드'로 추상화합니다.
    카드 ID는 UUID4 기반 8자리 식별자로 생성됩니다.

    SDK는 TextBlock을 청크 스트리밍하지 않으므로 TEXT_DELTA 하나가
    하나의 완전한 카드에 해당합니다.
    """

    def __init__(self) -> None:
        self._current_card_id: Optional[str] = None
        self._last_tool_name: Optional[str] = None
        self._tool_use_card_map: dict[str, Optional[str]] = {}  # tool_use_id → card_id
        self._tool_start_times: dict[str, float] = {}  # tool_use_id → start_time (monotonic)

    def new_card(self) -> str:
        """새 카드 ID 생성 및 현재 카드로 설정

        Returns:
            생성된 카드 ID (8자리 hex)
        """
        self._current_card_id = uuid.uuid4().hex[:8]
        return self._current_card_id

    @property
    def current_card_id(self) -> Optional[str]:
        """현재 활성 카드 ID (thinking 블록 없이 tool이 오면 None)"""
        return self._current_card_id

    def set_last_tool(self, tool_name: str) -> None:
        """마지막 도구 이름 기록 (TOOL_RESULT에서 tool_name 폴백용)"""
        self._last_tool_name = tool_name

    @property
    def last_tool(self) -> Optional[str]:
        """마지막으로 호출된 도구 이름"""
        return self._last_tool_name

    def register_tool_call(self, tool_use_id: str, card_id: Optional[str]) -> None:
        """tool_use_id에 대한 card_id를 기록 (TOOL_RESULT에서 올바른 card_id 조회용)"""
        self._tool_use_card_map[tool_use_id] = card_id

    def get_tool_card_id(self, tool_use_id: Optional[str]) -> Optional[str]:
        """tool_use_id로 TOOL_START 시점의 card_id를 조회"""
        if tool_use_id and tool_use_id in self._tool_use_card_map:
            return self._tool_use_card_map[tool_use_id]
        return self._current_card_id

    def start_tool(self, tool_use_id: str) -> None:
        """도구 시작 시간 기록

        Args:
            tool_use_id: SDK ToolUseBlock ID
        """
        if tool_use_id:
            self._tool_start_times[tool_use_id] = time.monotonic()

    def end_tool(self, tool_use_id: Optional[str]) -> Optional[int]:
        """도구 종료 시 경과 시간(ms) 반환

        Args:
            tool_use_id: SDK ToolUseBlock ID

        Returns:
            경과 시간(밀리초), tool_use_id가 없거나 시작 시간이 기록되지 않은 경우 None
        """
        if tool_use_id and tool_use_id in self._tool_start_times:
            start = self._tool_start_times.pop(tool_use_id)
            return int((time.monotonic() - start) * 1000)
        return None


@dataclass
class InterventionMessage:
    """개입 메시지 데이터"""
    text: str
    user: str
    attachment_paths: List[str]


def _extract_context_usage(usage: Optional[dict]) -> Optional[ContextUsageEvent]:
    """EngineResult.usage에서 컨텍스트 사용량 이벤트 생성"""
    if not usage:
        return None

    input_tokens = usage.get("input_tokens", 0)
    output_tokens = usage.get("output_tokens", 0)
    total_used = input_tokens + output_tokens

    if total_used <= 0:
        return None

    max_tokens = DEFAULT_MAX_CONTEXT_TOKENS
    percent = (total_used / max_tokens) * 100 if max_tokens > 0 else 0

    logger.info(
        f"Context usage: input={input_tokens:,}, output={output_tokens:,}, "
        f"total={total_used:,}/{max_tokens:,} ({percent:.1f}%)"
    )

    return ContextUsageEvent(
        used_tokens=total_used,
        max_tokens=max_tokens,
        percent=round(percent, 1),
    )


def _build_intervention_prompt(msg: InterventionMessage) -> str:
    """개입 메시지를 Claude 프롬프트로 변환"""
    if msg.attachment_paths:
        attachment_info = "\n".join([f"- {p}" for p in msg.attachment_paths])
        return (
            f"[사용자 개입 메시지 from {msg.user}]\n"
            f"{msg.text}\n\n"
            f"첨부 파일 (Read 도구로 확인):\n"
            f"{attachment_info}"
        )
    return f"[사용자 개입 메시지 from {msg.user}]\n{msg.text}"


def _build_credential_alert_event(alert: dict) -> CredentialAlertEvent:
    """RateLimitTracker의 alert dict → CredentialAlertEvent 변환."""
    profiles = []
    for p in alert.get("profiles", []):
        five_hour = p.get("five_hour", {})
        seven_day = p.get("seven_day", {})
        profiles.append(RateLimitProfileInfo(
            name=p["name"],
            five_hour=RateLimitProfileStatus(
                utilization=five_hour.get("utilization", "unknown"),
                resets_at=five_hour.get("resets_at"),
            ),
            seven_day=RateLimitProfileStatus(
                utilization=seven_day.get("utilization", "unknown"),
                resets_at=seven_day.get("resets_at"),
            ),
        ))
    return CredentialAlertEvent(
        active_profile=alert["active_profile"],
        profiles=profiles,
    )


class SoulEngineAdapter:
    """ClaudeRunner -> AsyncIterator[SSE Event] 어댑터

    ClaudeRunner.run()의 콜백(on_progress, on_compact, on_intervention)을
    asyncio.Queue를 통해 SSE 이벤트 스트림으로 변환합니다.
    기존 soul의 ClaudeCodeRunner.execute()와 동일한 인터페이스를 제공합니다.

    Serendipity 연동:
      세션 시작/종료 및 SSE 이벤트를 세렌디피티에 저장합니다.
    """

    def __init__(
        self,
        workspace_dir: Optional[str] = None,
        pool: Optional["RunnerPool"] = None,
        rate_limit_tracker: Optional[Any] = None,
        serendipity_adapter: Optional["SerendipityAdapter"] = None,
    ):
        self._workspace_dir = workspace_dir or get_settings().workspace_dir
        self._pool = pool
        self._rate_limit_tracker = rate_limit_tracker
        self._serendipity_adapter = serendipity_adapter

    def _resolve_mcp_config_path(self) -> Optional[Path]:
        """WORKSPACE_DIR 기준으로 mcp_config.json 경로를 해석"""
        config_path = Path(self._workspace_dir) / "mcp_config.json"
        if config_path.exists():
            return config_path
        return None

    async def execute(
        self,
        prompt: str,
        resume_session_id: Optional[str] = None,
        get_intervention: Optional[Callable[[], Awaitable[Optional[dict]]]] = None,
        on_intervention_sent: Optional[Callable[[str, str], Awaitable[None]]] = None,
        *,
        allowed_tools: Optional[List[str]] = None,
        disallowed_tools: Optional[List[str]] = None,
        use_mcp: bool = True,
        client_id: Optional[str] = None,
        request_id: Optional[str] = None,
        persona: Optional[str] = None,
    ) -> AsyncIterator:
        """Claude Code 실행 (SSE 이벤트 스트림)

        기존 soul의 ClaudeCodeRunner.execute()와 동일한 인터페이스.

        Args:
            prompt: 사용자 프롬프트
            resume_session_id: 이전 세션 ID
            get_intervention: 개입 메시지 가져오기 함수
            on_intervention_sent: 개입 전송 후 콜백
            allowed_tools: 허용 도구 목록 (None이면 기본값 사용)
            disallowed_tools: 금지 도구 목록 (None이면 기본값 사용)
            use_mcp: MCP 서버 연결 여부
            client_id: 클라이언트 ID (세렌디피티 저장용)
            request_id: 요청 ID (세렌디피티 저장용)
            persona: 페르소나 이름 (세렌디피티 저장용)

        Yields:
            ProgressEvent | InterventionSentEvent | ContextUsageEvent
            | CompactEvent | DebugEvent | CompleteEvent | ErrorEvent
        """
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        # 요청별 도구 설정 적용 (None이면 제한 없음 — MCP 도구 포함 전체 허용)
        effective_allowed = allowed_tools
        effective_disallowed = disallowed_tools if disallowed_tools is not None else DEFAULT_DISALLOWED_TOOLS

        # MCP 설정
        mcp_config_path = self._resolve_mcp_config_path() if use_mcp else None

        # Serendipity 세션 시작
        serendipity_ctx: Optional["SessionContext"] = None
        if self._serendipity_adapter is not None and client_id and request_id:
            try:
                serendipity_ctx = await self._serendipity_adapter.start_session(
                    client_id=client_id,
                    request_id=request_id,
                    prompt=prompt,
                    persona=persona,
                )
            except Exception as e:
                logger.warning(f"Serendipity session start failed: {e}")

        # debug_send_fn: 동기 콜백 → 큐 어댑터
        # ClaudeRunner._debug()는 동기 함수이므로 call_soon_threadsafe로 큐에 enqueue
        def debug_send_fn(message: str) -> None:
            try:
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    DebugEvent(message=message),
                )
            except Exception:
                pass  # 큐 닫힘 등 무시

        # alert_send_fn: RateLimitTracker 알림 → 큐 어댑터
        def alert_send_fn(alert: dict) -> None:
            try:
                event = _build_credential_alert_event(alert)
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except Exception:
                pass

        # --- 콜백 → 큐 어댑터 ---

        async def on_progress(text: str) -> None:
            await queue.put(ProgressEvent(text=text))

        async def on_compact(trigger: str, message: str) -> None:
            await queue.put(CompactEvent(trigger=trigger, message=message))

        async def on_intervention_callback() -> Optional[str]:
            """인터벤션 폴링: dict → prompt 문자열 변환"""
            if not get_intervention:
                return None

            intervention = await get_intervention()
            if not intervention:
                return None

            msg = InterventionMessage(
                text=intervention.get("text", ""),
                user=intervention.get("user", ""),
                attachment_paths=intervention.get("attachment_paths", []),
            )

            # 이벤트 발행 + 콜백 호출
            intervention_event = InterventionSentEvent(user=msg.user, text=msg.text)
            await queue.put(intervention_event)
            if on_intervention_sent:
                await on_intervention_sent(msg.user, msg.text)

            # Serendipity에 전달
            if serendipity_ctx and self._serendipity_adapter:
                try:
                    await self._serendipity_adapter.on_event(serendipity_ctx, intervention_event)
                except Exception as e:
                    logger.warning(f"Serendipity intervention event failed: {e}")

            return _build_intervention_prompt(msg)

        # --- 세션 ID 조기 통지 ---

        async def on_session_callback(session_id: str) -> None:
            """ClaudeRunner가 SystemMessage에서 session_id를 받으면 즉시 SSE 이벤트 발행"""
            await queue.put(SessionEvent(session_id=session_id))

        # --- 세분화 이벤트 (dashboard용) ---

        tracker = _CardTracker()

        async def on_engine_event(event: EngineEvent) -> None:
            """ClaudeRunner 엔진 이벤트 → 세분화 SSE 이벤트 변환

            기존 on_progress/on_compact 이벤트와 병행 발행됩니다.
            슬랙봇 하위호환 유지: 기존 이벤트를 대체하지 않습니다.

            Serendipity 연동: SSE 이벤트를 세렌디피티에도 저장합니다.
            """
            sse_event = None  # 세렌디피티에 전달할 이벤트

            if event.type == EngineEventType.THINKING:
                thinking = event.data.get("thinking", "")
                signature = event.data.get("signature", "")
                # ThinkingBlock = 하나의 카드
                card_id = tracker.new_card()
                sse_event = ThinkingSSEEvent(
                    card_id=card_id,
                    thinking=thinking,
                    signature=signature,
                    parent_tool_use_id=event.parent_tool_use_id,
                )
                await queue.put(sse_event)

                # Serendipity에 전달
                if serendipity_ctx and self._serendipity_adapter:
                    try:
                        await self._serendipity_adapter.on_event(serendipity_ctx, sse_event)
                    except Exception as e:
                        logger.warning(f"Serendipity thinking event failed: {e}")
                return

            elif event.type == EngineEventType.TEXT_DELTA:
                text = event.data.get("text", "")
                # TextBlock 전체 = 하나의 카드 (SDK는 청크 스트리밍 미지원)
                card_id = tracker.new_card()
                text_start = TextStartSSEEvent(
                    card_id=card_id,
                    parent_tool_use_id=event.parent_tool_use_id,
                )
                text_delta = TextDeltaSSEEvent(card_id=card_id, text=text)
                text_end = TextEndSSEEvent(card_id=card_id)
                await queue.put(text_start)
                await queue.put(text_delta)
                await queue.put(text_end)

                # Serendipity에 전달 (text_start, text_delta, text_end 순서)
                if serendipity_ctx and self._serendipity_adapter:
                    try:
                        await self._serendipity_adapter.on_event(serendipity_ctx, text_start)
                        await self._serendipity_adapter.on_event(serendipity_ctx, text_delta)
                        await self._serendipity_adapter.on_event(serendipity_ctx, text_end)
                    except Exception as e:
                        logger.warning(f"Serendipity event failed: {e}")
                return

            elif event.type == EngineEventType.TOOL_START:
                tool_name = event.data.get("tool_name", "")
                tool_input = event.data.get("tool_input", {})
                tool_use_id = event.data.get("tool_use_id")
                # SSE 페이로드 크기 제한: 대형 tool_input 방지
                try:
                    import json as _json
                    tool_input_str = _json.dumps(tool_input, ensure_ascii=False)
                    if len(tool_input_str) > 2000:
                        tool_input = {"_truncated": tool_input_str[:2000] + "..."}
                except (TypeError, ValueError):
                    tool_input = {"_error": "serialize_failed"}
                tracker.set_last_tool(tool_name)
                # tool_use_id → card_id 매핑 기록 (TOOL_RESULT에서 올바른 card_id 조회용)
                if tool_use_id:
                    tracker.register_tool_call(tool_use_id, tracker.current_card_id)
                    tracker.start_tool(tool_use_id)
                sse_event = ToolStartSSEEvent(
                    card_id=tracker.current_card_id,
                    tool_name=tool_name,
                    tool_input=tool_input,
                    tool_use_id=tool_use_id,
                    parent_tool_use_id=event.parent_tool_use_id,
                )
                await queue.put(sse_event)

            elif event.type == EngineEventType.TOOL_RESULT:
                result = event.data.get("result", "")
                is_error = event.data.get("is_error", False)
                tool_use_id = event.data.get("tool_use_id")
                # tool_name은 이벤트 페이로드 우선, 없으면 tracker 폴백
                tool_name = event.data.get("tool_name") or tracker.last_tool or ""
                # card_id는 tool_use_id로 TOOL_START 시점의 값을 조회
                card_id = tracker.get_tool_card_id(tool_use_id)
                # 도구 실행 시간 계산
                duration_ms = tracker.end_tool(tool_use_id)
                sse_event = ToolResultSSEEvent(
                    card_id=card_id,
                    tool_name=tool_name,
                    result=result,
                    is_error=is_error,
                    tool_use_id=tool_use_id,
                    duration_ms=duration_ms,
                    parent_tool_use_id=event.parent_tool_use_id,
                )
                await queue.put(sse_event)

            elif event.type == EngineEventType.RESULT:
                success = event.data.get("success", False)
                output = event.data.get("output", "")
                error = event.data.get("error")
                sse_event = ResultSSEEvent(
                    success=success,
                    output=output,
                    error=error,
                )
                await queue.put(sse_event)

            elif event.type == EngineEventType.SUBAGENT_START:
                agent_id = event.data.get("agent_id", "")
                agent_type = event.data.get("agent_type", "")
                sse_event = SubagentStartSSEEvent(
                    agent_id=agent_id,
                    agent_type=agent_type,
                    parent_tool_use_id=event.parent_tool_use_id,
                )
                await queue.put(sse_event)

            elif event.type == EngineEventType.SUBAGENT_STOP:
                agent_id = event.data.get("agent_id", "")
                sse_event = SubagentStopSSEEvent(
                    agent_id=agent_id,
                )
                await queue.put(sse_event)

            # Serendipity에 이벤트 전달
            if sse_event and serendipity_ctx and self._serendipity_adapter:
                try:
                    await self._serendipity_adapter.on_event(serendipity_ctx, sse_event)
                except Exception as e:
                    logger.warning(f"Serendipity event failed: {e}")

        # --- 백그라운드 실행 ---

        async def run_claude() -> None:
            # 풀이 있으면 acquire, 없으면 직접 생성
            if self._pool is not None:
                runner = await self._pool.acquire(session_id=resume_session_id)
                # W-3: 풀에서 꺼낸 runner에 요청별 debug_send_fn 주입
                runner.debug_send_fn = debug_send_fn
                # W-4: 풀에서 꺼낸 runner에 요청별 도구 설정 주입
                runner.allowed_tools = effective_allowed
                runner.disallowed_tools = effective_disallowed
            else:
                runner = ClaudeRunner(
                    working_dir=Path(self._workspace_dir),
                    allowed_tools=effective_allowed,
                    disallowed_tools=effective_disallowed,
                    mcp_config_path=mcp_config_path,
                    debug_send_fn=debug_send_fn,
                )

            # rate limit tracker 주입
            if self._rate_limit_tracker is not None:
                runner.rate_limit_tracker = self._rate_limit_tracker
                runner.alert_send_fn = alert_send_fn

            success = False
            try:
                result = await runner.run(
                    prompt=prompt,
                    session_id=resume_session_id,
                    on_progress=on_progress,
                    on_compact=on_compact,
                    on_intervention=on_intervention_callback,
                    on_session=on_session_callback,
                    on_event=on_engine_event,
                )

                # 컨텍스트 사용량 이벤트
                ctx_event = _extract_context_usage(result.usage)
                if ctx_event:
                    await queue.put(ctx_event)

                # 완료/에러 이벤트
                if result.success and not result.is_error:
                    final_text = result.output or "(결과 없음)"
                    complete_event = CompleteEvent(
                        result=final_text,
                        attachments=[],
                        claude_session_id=result.session_id,
                    )
                    await queue.put(complete_event)
                    success = True
                    # 성공 시 풀에 반환
                    if self._pool is not None:
                        await self._pool.release(runner, session_id=result.session_id)
                    # Serendipity에 전달
                    if serendipity_ctx and self._serendipity_adapter:
                        try:
                            await self._serendipity_adapter.on_event(serendipity_ctx, complete_event)
                        except Exception as e:
                            logger.warning(f"Serendipity complete event failed: {e}")
                else:
                    error_msg = result.error or result.output or "실행 오류"
                    error_event = ErrorEvent(message=error_msg)
                    await queue.put(error_event)
                    # C-1: 에러 시 runner 폐기 (오염 방지)
                    if self._pool is not None:
                        await self._pool._discard(runner, reason="run_error")
                    # Serendipity에 전달
                    if serendipity_ctx and self._serendipity_adapter:
                        try:
                            await self._serendipity_adapter.on_event(serendipity_ctx, error_event)
                        except Exception as e:
                            logger.warning(f"Serendipity error event failed: {e}")

            except Exception as e:
                logger.exception(f"SoulEngineAdapter execution error: {e}")
                error_event = ErrorEvent(message=f"실행 오류: {str(e)}")
                await queue.put(error_event)
                # C-1: 예외 시 runner 폐기 (고아 프로세스 방지)
                if self._pool is not None:
                    await self._pool._discard(runner, reason="exception")
                # Serendipity에 전달
                if serendipity_ctx and self._serendipity_adapter:
                    try:
                        await self._serendipity_adapter.on_event(serendipity_ctx, error_event)
                    except Exception as ex:
                        logger.warning(f"Serendipity error event failed: {ex}")

            finally:
                await queue.put(_DONE)

        # 백그라운드 태스크 시작
        task = asyncio.create_task(run_claude())

        try:
            while True:
                event = await queue.get()
                if event is _DONE:
                    break
                yield event
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass


# 싱글톤 인스턴스 (lifespan에서 init_soul_engine()으로 재초기화 가능)
soul_engine = SoulEngineAdapter()


def init_soul_engine(
    pool: Optional["RunnerPool"] = None,
    rate_limit_tracker: Optional[Any] = None,
    serendipity_adapter: Optional["SerendipityAdapter"] = None,
) -> SoulEngineAdapter:
    """soul_engine 싱글톤을 (재)초기화한다.

    lifespan에서 풀 생성 후 호출하여 싱글톤을 교체한다.

    Args:
        pool: 주입할 RunnerPool. None이면 풀 없이 초기화.
        rate_limit_tracker: RateLimitTracker 인스턴스. None이면 추적 비활성화.
        serendipity_adapter: SerendipityAdapter 인스턴스. None이면 세렌디피티 저장 비활성화.

    Returns:
        새로 생성된 SoulEngineAdapter 인스턴스
    """
    global soul_engine
    soul_engine = SoulEngineAdapter(
        pool=pool,
        rate_limit_tracker=rate_limit_tracker,
        serendipity_adapter=serendipity_adapter,
    )
    return soul_engine
