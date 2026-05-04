"""soul 엔진 어댑터

ClaudeRunner를 soul API용으로 래핑합니다.
ClaudeRunner.run()의 콜백(on_progress, on_compact, on_intervention)을
asyncio.Queue를 통해 SSE 이벤트 스트림으로 변환하여
기존 soul 스트리밍 인터페이스와 호환합니다.
"""

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable, List, Optional, Union

from soul_server.claude.agent_runner import ClaudeRunner
from soul_server.config import get_settings
from soul_server.engine.types import EngineEvent
from soul_server.service.context_builder import build_soulstream_context_item, format_context_items

if TYPE_CHECKING:
    from soul_server.cogito.brief_composer import BriefComposer
    from soul_server.service.runner_pool import RunnerPool
from soul_server.models import (
    AwaySummarySSEEvent,
    CompactEvent,
    CompleteEvent,
    ContextUsageEvent,
    CredentialAlertEvent,
    DebugEvent,
    ErrorEvent,
    InputRequestExpiredSSEEvent,
    InterventionSentEvent,
    ProgressEvent,
    SessionEvent,
)

logger = logging.getLogger(__name__)

# SSE 이벤트 타입 alias - execute()가 yield할 수 있는 모든 이벤트 타입
SSEEvent = Union[
    ProgressEvent,
    SessionEvent,
    InterventionSentEvent,
    ContextUsageEvent,
    CompactEvent,
    DebugEvent,
    CompleteEvent,
    ErrorEvent,
    CredentialAlertEvent,
    InputRequestExpiredSSEEvent,
    AwaySummarySSEEvent,
]

DEFAULT_DISALLOWED_TOOLS = ["NotebookEdit", "TodoWrite"]

# 컨텍스트 관련 상수
DEFAULT_MAX_CONTEXT_TOKENS = 200_000

# sentinel: 스트리밍 종료 신호
_DONE = object()


@dataclass
class InterventionMessage:
    """개입 메시지 데이터"""
    text: str
    user: str
    attachment_paths: List[str]


@dataclass
class _ExecutionHandlers:
    """execute() 백그라운드 실행에 필요한 콜백 묶음.

    _make_handlers()로 생성하여 _run_claude_task()에 전달한다.
    runner.run()에 전달되는 async 콜백과, ClaudeRunner 생성 시 주입되는
    동기 콜백(debug/alert)을 한 묶음으로 관리한다.
    """
    on_progress: Callable[[str], Awaitable[None]]
    on_compact: Callable[[str, str], Awaitable[None]]
    on_intervention_callback: Callable[[], Awaitable[Optional[str]]]
    on_session_callback: Callable[[str], Awaitable[None]]
    on_engine_event: Callable[[EngineEvent], Awaitable[None]]
    debug_send_fn: Callable[[str], None]
    alert_send_fn: Callable[[dict], None]


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
    return CredentialAlertEvent(
        utilization=alert["utilization"],
        rate_limit_type=alert["rate_limit_type"],
    )


class SoulEngineAdapter:
    """ClaudeRunner -> AsyncIterator[SSE Event] 어댑터

    ClaudeRunner.run()의 콜백(on_progress, on_compact, on_intervention)을
    asyncio.Queue를 통해 SSE 이벤트 스트림으로 변환합니다.
    기존 soul의 ClaudeCodeRunner.execute()와 동일한 인터페이스를 제공합니다.
    """

    def __init__(
        self,
        workspace_dir: Optional[str] = None,
        pool: Optional["RunnerPool"] = None,
        rate_limit_tracker: Optional[Any] = None,
        brief_composer: Optional["BriefComposer"] = None,
    ):
        self._workspace_dir = workspace_dir or get_settings().workspace_dir
        self._pool = pool
        self._rate_limit_tracker = rate_limit_tracker
        self._brief_composer = brief_composer

    @property
    def workspace_dir(self) -> str:
        return self._workspace_dir

    def _resolve_mcp_config_path(self) -> Optional[Path]:
        """WORKSPACE_DIR 기준으로 mcp_config.json 경로를 해석"""
        config_path = Path(self._workspace_dir) / "mcp_config.json"
        if config_path.exists():
            return config_path
        return None

    async def _acquire_runner(
        self,
        *,
        working_dir: Optional[str],
        resume_session_id: Optional[str],
        effective_allowed: Optional[List[str]],
        effective_disallowed: Optional[List[str]],
        mcp_config_path: Optional[Path],
        debug_send_fn: Any,
        alert_send_fn: Any,
        model: Optional[str],
        system_prompt: Optional[str],
        max_turns: Optional[int],
    ) -> "ClaudeRunner":
        """Runner 획득: on-demand / pool / direct 3분기.

        working_dir이 기본 workspace_dir와 다르면 풀을 우회하고 on-demand 생성한다.
        풀이 있으면 acquire, 없으면 기본 workspace_dir로 직접 생성한다.

        Returns:
            ClaudeRunner 인스턴스 (rate_limit_tracker 주입 완료)
        """
        if working_dir and working_dir != str(self._workspace_dir):
            runner = ClaudeRunner(
                working_dir=Path(working_dir),
                allowed_tools=effective_allowed,
                disallowed_tools=effective_disallowed,
                mcp_config_path=mcp_config_path,
                debug_send_fn=debug_send_fn,
                model=model,
                system_prompt=system_prompt,
                max_turns=max_turns,
            )
        elif self._pool is not None:
            runner = await self._pool.acquire(session_id=resume_session_id)
            runner.debug_send_fn = debug_send_fn
            runner.allowed_tools = effective_allowed
            runner.disallowed_tools = effective_disallowed
            runner.system_prompt = system_prompt
            if max_turns is not None:
                runner.max_turns = max_turns
        else:
            runner = ClaudeRunner(
                working_dir=Path(self._workspace_dir),
                allowed_tools=effective_allowed,
                disallowed_tools=effective_disallowed,
                mcp_config_path=mcp_config_path,
                debug_send_fn=debug_send_fn,
                model=model,
                system_prompt=system_prompt,
                max_turns=max_turns,
            )

        if self._rate_limit_tracker is not None:
            runner.rate_limit_tracker = self._rate_limit_tracker
            runner.alert_send_fn = alert_send_fn

        return runner

    def _make_handlers(
        self,
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
        runner_ref: List[Optional[ClaudeRunner]],
        get_intervention: Optional[Callable[[], Awaitable[Optional[dict]]]],
        on_intervention_sent: Optional[Callable[[str, str, List[str]], Awaitable[None]]],
    ) -> _ExecutionHandlers:
        """ClaudeRunner와 SSE 큐 사이의 콜백 어댑터들을 생성한다.

        모든 콜백은 queue/loop/runner_ref를 클로저로 공유한다.
        runner_ref는 _run_claude_task가 runner 생성 후 [0]에 채워 넣는 list이며,
        on_session_callback이 runner.pid에 접근하기 위해 사용한다.
        """

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
                await on_intervention_sent(msg.user, msg.text, msg.attachment_paths)

            return _build_intervention_prompt(msg)

        async def on_session_callback(session_id: str) -> None:
            """SystemMessage의 session_id 수신 시 SSE 이벤트 발행. runner.pid 접근 안전."""
            runner_pid = runner_ref[0].pid if runner_ref[0] else None
            await queue.put(SessionEvent(session_id=session_id, pid=runner_pid))

        async def on_engine_event(event: EngineEvent) -> None:
            """EngineEvent → SSE 이벤트 변환 (각 이벤트가 to_sse()로 자기 변환)."""
            sse_events = event.to_sse()
            for sse in sse_events:
                await queue.put(sse)

        return _ExecutionHandlers(
            on_progress=on_progress,
            on_compact=on_compact,
            on_intervention_callback=on_intervention_callback,
            on_session_callback=on_session_callback,
            on_engine_event=on_engine_event,
            debug_send_fn=debug_send_fn,
            alert_send_fn=alert_send_fn,
        )

    async def _run_claude_task(
        self,
        queue: asyncio.Queue,
        handlers: _ExecutionHandlers,
        effective_prompt: str,
        resume_session_id: Optional[str],
        extra_env: Optional[dict],
        on_runner_ready: Optional[Callable[["ClaudeRunner"], None]],
        runner_ref: List[Optional[ClaudeRunner]],
        acquire_runner_kwargs: dict,
    ) -> None:
        """백그라운드 ClaudeRunner 실행 태스크.

        runner 획득 → run() 실행 → 성공/에러/예외 분기 처리 후
        반드시 _DONE을 큐에 발행하여 execute()의 drain loop를 종료시킨다.
        """
        runner = await self._acquire_runner(
            **acquire_runner_kwargs,
            debug_send_fn=handlers.debug_send_fn,
            alert_send_fn=handlers.alert_send_fn,
        )

        # runner 참조 저장 (on_session_callback에서 pid 접근용)
        runner_ref[0] = runner

        # runner 준비 알림 (AskUserQuestion 응답 전달 경로 구축용)
        if on_runner_ready:
            on_runner_ready(runner)

        try:
            result = await runner.run(
                prompt=effective_prompt,
                session_id=resume_session_id,
                on_progress=handlers.on_progress,
                on_compact=handlers.on_compact,
                on_intervention=handlers.on_intervention_callback,
                on_session=handlers.on_session_callback,
                on_event=handlers.on_engine_event,
                extra_env=extra_env,
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
                    parent_event_id=None,  # task_executor가 user_request_id로 채움
                )
                await queue.put(complete_event)
                # 성공 시 풀에 반환
                if self._pool is not None:
                    await self._pool.release(runner, session_id=result.session_id)
            else:
                error_msg = result.error or result.output or "실행 오류"
                error_event = ErrorEvent(
                    message=error_msg,
                    parent_event_id=None,  # task_executor가 user_request_id로 채움
                )
                await queue.put(error_event)
                # C-1: 에러 시 runner 폐기 (오염 방지)
                if self._pool is not None:
                    await self._pool.discard(runner, reason="run_error")

        except Exception as e:
            logger.exception(f"SoulEngineAdapter execution error: {e}")
            error_event = ErrorEvent(
                message=f"실행 오류: {str(e)}",
                parent_event_id=None,  # task_executor가 user_request_id로 채움
            )
            await queue.put(error_event)
            # C-1: 예외 시 runner 폐기 (고아 프로세스 방지)
            if self._pool is not None:
                await self._pool.discard(runner, reason="exception")

        finally:
            await queue.put(_DONE)

    async def execute(
        self,
        prompt: str,
        resume_session_id: Optional[str] = None,
        get_intervention: Optional[Callable[[], Awaitable[Optional[dict]]]] = None,
        on_intervention_sent: Optional[Callable[[str, str, List[str]], Awaitable[None]]] = None,
        *,
        allowed_tools: Optional[List[str]] = None,
        disallowed_tools: Optional[List[str]] = None,
        use_mcp: bool = True,
        client_id: Optional[str] = None,
        request_id: Optional[str] = None,
        persona: Optional[str] = None,
        on_runner_ready: Optional[Callable[["ClaudeRunner"], None]] = None,
        context_items: Optional[List[dict]] = None,
        agent_session_id: Optional[str] = None,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        working_dir: Optional[str] = None,   # Phase 1 추가 (Phase 2에서 실제 사용)
        max_turns: Optional[int] = None,     # Phase 1 추가 (Phase 2에서 실제 사용)
        extra_env: Optional[dict] = None,    # per-process 환경변수 오버라이드 (os.environ 미수정)
    ) -> AsyncIterator[SSEEvent]:
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
            client_id: 클라이언트 ID
            request_id: 요청 ID
            persona: 페르소나 이름
            context_items: 클라이언트가 전달한 추가 컨텍스트 항목 목록
            agent_session_id: 세션 식별자 (소울스트림 자체 context_item에 포함)

        Yields:
            ProgressEvent | InterventionSentEvent | ContextUsageEvent
            | CompactEvent | DebugEvent | CompleteEvent | ErrorEvent
        """
        # Cogito brief refresh (failure isolated — 실패해도 세션 진행)
        if self._brief_composer is not None:
            try:
                await self._brief_composer.write_brief()
            except Exception as e:
                logger.warning("Cogito brief refresh failed: %s", e)

        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        # 요청별 도구 설정 적용 (None이면 제한 없음 — MCP 도구 포함 전체 허용)
        effective_allowed = allowed_tools
        effective_disallowed = disallowed_tools if disallowed_tools is not None else DEFAULT_DISALLOWED_TOOLS

        # MCP 설정
        mcp_config_path = self._resolve_mcp_config_path() if use_mcp else None

        # 프롬프트 앞에 context 블록 삽입
        # context_items는 task_executor에서 서버 컨텍스트와 머지된 상태로 전달됨
        context_block = format_context_items(context_items or [])
        effective_prompt = context_block + "\n\n" + prompt

        # runner 참조: _run_claude_task가 runner 생성 후 [0]에 채워 넣는 list.
        # on_session_callback이 runner.pid에 접근하기 위해 사용한다.
        runner_ref: List[Optional[ClaudeRunner]] = [None]

        # 콜백 묶음 생성
        handlers = self._make_handlers(
            queue=queue,
            loop=loop,
            runner_ref=runner_ref,
            get_intervention=get_intervention,
            on_intervention_sent=on_intervention_sent,
        )

        # 백그라운드 태스크 시작
        task = asyncio.create_task(self._run_claude_task(
            queue=queue,
            handlers=handlers,
            effective_prompt=effective_prompt,
            resume_session_id=resume_session_id,
            extra_env=extra_env,
            on_runner_ready=on_runner_ready,
            runner_ref=runner_ref,
            acquire_runner_kwargs={
                "working_dir": working_dir,
                "resume_session_id": resume_session_id,
                "effective_allowed": effective_allowed,
                "effective_disallowed": effective_disallowed,
                "mcp_config_path": mcp_config_path,
                "model": model,
                "system_prompt": system_prompt,
                "max_turns": max_turns,
            },
        ))

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


def get_soul_engine() -> SoulEngineAdapter:
    """현재 soul_engine 싱글톤 인스턴스를 반환한다.

    모듈 로드 시점이 아닌 호출 시점의 전역 변수를 참조하므로,
    init_soul_engine()으로 재초기화된 인스턴스를 올바르게 반환한다.
    """
    return soul_engine


def init_soul_engine(
    pool: Optional["RunnerPool"] = None,
    rate_limit_tracker: Optional[Any] = None,
    brief_composer: Optional["BriefComposer"] = None,
) -> SoulEngineAdapter:
    """soul_engine 싱글톤을 (재)초기화한다.

    lifespan에서 풀 생성 후 호출하여 싱글톤을 교체한다.

    Args:
        pool: 주입할 RunnerPool. None이면 풀 없이 초기화.
        rate_limit_tracker: RateLimitTracker 인스턴스. None이면 추적 비활성화.
        brief_composer: BriefComposer 인스턴스. None이면 브리프 생성 비활성화.

    Returns:
        새로 생성된 SoulEngineAdapter 인스턴스
    """
    global soul_engine
    soul_engine = SoulEngineAdapter(
        pool=pool,
        rate_limit_tracker=rate_limit_tracker,
        brief_composer=brief_composer,
    )
    return soul_engine
