"""Claude Code SDK 기반 실행기"""

import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Optional, Callable, Awaitable

try:
    from claude_agent_sdk import (
        ClaudeAgentOptions,
        ClaudeSDKClient,
        HookMatcher,
        HookContext,
        ProcessError,
    )
    from claude_agent_sdk._errors import MessageParseError
    from claude_agent_sdk.types import (
        ResultMessage,
        ToolPermissionContext,
    )
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False
    # 더미 클래스 (import 에러 방지)
    class ClaudeAgentOptions:
        pass
    class ClaudeSDKClient:
        pass
    class HookMatcher:
        pass
    class HookContext:
        pass
    class MessageParseError(Exception):
        pass
    class ProcessError(Exception):
        pass
    class ResultMessage:
        pass
    class ToolPermissionContext:
        pass

from soul_server.claude.diagnostics import (
    DebugSendFn,
    build_session_dump,
    classify_process_error,
    format_rate_limit_warning,
)
from soul_server.claude.client_lifecycle import (
    ClientLifecycle,
    _client_lifecycle_task,  # noqa: F401 — re-export for backwards compat
    compute_options_fingerprint,
    force_kill_process,
)
from soul_server.claude.error_handlers import (
    finalize_result as _finalize_result_fn,
    handle_file_not_found as _handle_file_not_found_fn,
    handle_process_error as _handle_process_error_fn,
    handle_parse_error as _handle_parse_error_fn,
    handle_unknown_error as _handle_unknown_error_fn,
)
from soul_server.engine.types import (
    EngineResult,
    InterventionCallback,
    EngineEvent,
    EventCallback,
)
from soul_server.claude.compact_retry import (
    CompactRetryHandler,
    COMPACT_RETRY_READ_TIMEOUT,
)
from soul_server.claude.hook_builder import build_hooks as _build_hooks_fn
from soul_server.claude.input_request import InputRequestHandler
from soul_server.claude.message_processor import MessageProcessor
from soul_server.claude.runner_registry import (
    get_runner,  # noqa: F401 — re-export
    register_runner,
    remove_runner,
    get_registry_size,
    shutdown_all,
    shutdown_all_sync,
    reset_shutdown_state,  # noqa: F401 — re-export
)
from soul_server.claude.sdk_compat import ParseAction, classify_parse_error
from soul_server.claude.session_validator import validate_session
from soul_server.utils.async_bridge import run_in_new_loop

logger = logging.getLogger(__name__)

# Claude Code 기본 금지 도구
DEFAULT_DISALLOWED_TOOLS = [
    "WebFetch",
    "WebSearch",
    "Task",
]


@dataclass
class ClaudeResult(EngineResult):
    """Claude Code 실행 결과 (하위호환 레이어)

    EngineResult를 상속하며, 응용 마커 필드를 추가합니다.
    마커 필드는 executor에서 ParsedMarkers를 통해 설정됩니다.
    """

    update_requested: bool = False
    restart_requested: bool = False
    list_run: Optional[str] = None  # <!-- LIST_RUN: 리스트명 --> 마커로 추출된 리스트 이름


INTERVENTION_POLL_INTERVAL = 1.0  # 초: 인터벤션 폴링 주기
MAX_INTERVENTION_DRAIN = 100  # _drain_interventions 안전 상한


@dataclass
class MessageState:
    """메시지 수신 루프 상태"""
    session_id: Optional[str] = None
    current_text: str = ""
    result_text: str = ""
    is_error: bool = False
    usage: Optional[dict] = None
    collected_messages: list[dict] = field(default_factory=list)
    msg_count: int = 0
    tool_use_id_to_name: dict = field(default_factory=dict)  # tool_use_id → tool_name 매핑
    emitted_tool_result_ids: set = field(default_factory=set)  # 중복 TOOL_RESULT 방지

    @property
    def has_result(self) -> bool:
        return bool(self.result_text or self.current_text)

    def reset_for_retry(self) -> None:
        """compact retry 시 텍스트 상태 리셋"""
        self.current_text = ""
        self.result_text = ""
        self.is_error = False


@dataclass
class ExecutionContext:
    """_execute() 실행 컨텍스트

    초기화 단계에서 생성되어 실행 전반에 걸쳐 사용되는 상태를 담습니다.

    Attributes:
        runner_id: Unique identifier for the runner instance
        session_start: UTC timestamp when execution started
        msg_state: Accumulated message state during execution
        compact_handler: Handler for compact retry logic
        stderr_file: File handle for CLI stderr capture (caller must close)
    """
    runner_id: str
    session_start: datetime
    msg_state: MessageState = field(default_factory=MessageState)
    compact_handler: "CompactRetryHandler" = field(default_factory=CompactRetryHandler)
    stderr_file: Optional[IO[str]] = None


class ClaudeRunner:
    """Claude Code SDK 기반 실행기

    runner_id 단위 인스턴스: 각 인스턴스가 자신의 client/pid/execution_loop를 소유합니다.
    SDK 클라이언트 라이프사이클은 ClientLifecycle에 위임합니다.
    """

    def __init__(
        self,
        *,
        working_dir: Optional[Path] = None,
        allowed_tools: Optional[list[str]] = None,
        disallowed_tools: Optional[list[str]] = None,
        mcp_config_path: Optional[Path] = None,
        debug_send_fn: Optional[DebugSendFn] = None,
        pooled: bool = False,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        max_turns: Optional[int] = None,
    ):
        import uuid as _uuid
        self.runner_id = _uuid.uuid4().hex[:8]
        self.working_dir = working_dir or Path.cwd()
        self.allowed_tools = allowed_tools  # None means no restriction
        self.disallowed_tools = disallowed_tools or DEFAULT_DISALLOWED_TOOLS
        self.mcp_config_path = mcp_config_path
        self.debug_send_fn = debug_send_fn
        self._pooled = pooled
        self.model = model
        self.system_prompt = system_prompt
        self.max_turns: Optional[int] = max_turns

        # Rate limit tracking
        self.rate_limit_tracker = None  # RateLimitTracker instance (injected by adapter)
        self.alert_send_fn: Optional[Callable] = None  # credential_alert 전송 콜백

        self.execution_loop: Optional[asyncio.AbstractEventLoop] = None

        # Subagent 추적을 위한 상태
        self._pending_events: deque[EngineEvent] = deque()  # 이벤트 큐
        # NOTE: SDK 한계로 SubagentStart에서 parent의 toolu_* ID를 획득할 수 없음.
        # PreToolUse는 toolu_* ID를, SubagentStart는 random UUID를 전달하며,
        # Task 도구는 isConcurrencySafe=true라 병렬 실행 시 순서 보장 불가.
        # → parent_event_id를 빈 문자열로 전달, 대시보드가 턴 루트에 연결.

        # AskUserQuestion 핸들러 (컴포지션)
        self._input_handler = InputRequestHandler(timeout=300.0)
        self._input_handler.bind_pending_events(self._pending_events.append)

        # SDK 클라이언트 라이프사이클 (컴포지션)
        self._lifecycle = ClientLifecycle(
            runner_id=self.runner_id,
            working_dir=self.working_dir,
            model=self.model,
            system_prompt=self.system_prompt,
            max_turns=self.max_turns,
            allowed_tools=self.allowed_tools,
            disallowed_tools=self.disallowed_tools,
            mcp_config_path=self.mcp_config_path,
            hooks_factory=lambda compact_events: _build_hooks_fn(
                compact_events, self._pending_events
            ),
            can_use_tool_factory=self._make_can_use_tool,
            rate_limit_observer=self._observe_rate_limit,
            unknown_event_observer=self._observe_unknown_event,
            force_kill_fn=lambda pid, runner_id: force_kill_process(pid, runner_id),
        )

    @classmethod
    async def shutdown_all_clients(cls) -> int:
        """하위 호환: 모듈 레벨 shutdown_all()로 위임"""
        return await shutdown_all()

    @classmethod
    def shutdown_all_clients_sync(cls) -> int:
        """하위 호환: 모듈 레벨 shutdown_all_sync()로 위임"""
        return shutdown_all_sync()

    def run_sync(self, coro):
        """동기 컨텍스트에서 코루틴을 실행하는 브릿지"""
        return run_in_new_loop(coro)

    def _drain_events(self) -> list[EngineEvent]:
        """큐의 모든 이벤트를 반환하고 비움"""
        events = list(self._pending_events)
        self._pending_events.clear()
        return events

    # Lifecycle 위임 메서드
    async def _get_or_create_client(
        self,
        session_id: Optional[str] = None,
        compact_events: Optional[list] = None,
        extra_env: Optional[dict] = None,
    ) -> tuple[ClaudeSDKClient, Optional["IO[str]"]]:
        """ClaudeSDKClient를 가져오거나 새로 생성 — ClientLifecycle에 위임.

        테스트가 patch.object(runner, "_build_options", ...)로 옵션 빌드를
        인터셉트할 수 있도록, Runner의 _build_options를 lifecycle에 전달한다.
        """
        return await self._lifecycle.get_or_create(
            session_id=session_id,
            compact_events=compact_events,
            extra_env=extra_env,
            build_options_fn=self._build_options,
        )

    async def _remove_client(self) -> None:
        """이 러너의 ClaudeSDKClient를 정리 — ClientLifecycle에 위임."""
        await self._lifecycle.remove()

    def detach_client(self) -> Optional[ClaudeSDKClient]:
        """풀이 runner를 회수할 때 client/pid를 안전하게 분리 — ClientLifecycle에 위임."""
        return self._lifecycle.detach()

    def is_idle(self) -> bool:
        """client가 연결되어 있고 현재 실행 중이 아닌지 확인."""
        return self._lifecycle.is_idle(
            is_execution_running=(
                self.execution_loop is not None and self.execution_loop.is_running()
            )
        )

    def _is_cli_alive(self) -> bool:
        """CLI 서브프로세스가 아직 살아있는지 확인 — ClientLifecycle에 위임."""
        return self._lifecycle.is_cli_alive()

    def _build_options(
        self,
        session_id: Optional[str] = None,
        compact_events: Optional[list] = None,
        extra_env: Optional[dict] = None,
    ) -> tuple[ClaudeAgentOptions, Optional[IO[str]]]:
        """ClaudeAgentOptions를 빌드 — ClientLifecycle에 위임."""
        return self._lifecycle.build_options(
            session_id=session_id,
            compact_events=compact_events,
            extra_env=extra_env,
        )

    # Runner 고유 메서드
    def interrupt(self) -> bool:
        """이 러너에 인터럽트 전송 (동기)"""
        client = self._lifecycle.client
        loop = self.execution_loop
        if client is None or loop is None or not loop.is_running():
            return False
        try:
            future = asyncio.run_coroutine_threadsafe(client.interrupt(), loop)
            future.result(timeout=5)
            logger.info(f"인터럽트 전송: runner={self.runner_id}")
            return True
        except Exception as e:
            logger.warning(f"인터럽트 실패: runner={self.runner_id}, {e}")
            return False

    def deliver_input_response(self, request_id: str, answers: dict) -> bool:
        """외부에서 AskUserQuestion 응답을 전달 — InputRequestHandler에 위임"""
        return self._input_handler.deliver_response(request_id, answers)

    def _make_can_use_tool(self):
        """AskUserQuestion 콜백 팩토리 — InputRequestHandler에 위임"""
        return self._input_handler.make_can_use_tool(self.runner_id)

    def _debug(self, message: str) -> None:
        """디버그 메시지 전송 (debug_send_fn이 있을 때만)"""
        if not self.debug_send_fn:
            return
        try:
            self.debug_send_fn(message)
        except Exception as e:
            logger.warning(f"디버그 메시지 전송 실패: {e}")

    def _observe_rate_limit(self, data: dict) -> None:
        """InstrumentedClaudeClient 콜백: rate_limit_event 관찰"""
        info = data.get("rate_limit_info", {})
        status = info.get("status", "")

        # 모든 상태에서 utilization 기록 (allowed 포함)
        if self.rate_limit_tracker is not None and isinstance(
            info.get("utilization"), (int, float)
        ):
            try:
                alert = self.rate_limit_tracker.record(info)
                if alert and self.alert_send_fn:
                    self.alert_send_fn(alert)
            except Exception as e:
                logger.warning(f"RateLimitTracker 기록 실패: {e}")

        if status == "allowed":
            return

        if status == "allowed_warning":
            warning_msg = format_rate_limit_warning(info)
            logger.info(f"rate_limit allowed_warning: {warning_msg}")
            self._debug(warning_msg)
            return

        # rejected, rate_limited 등
        logger.warning(
            f"rate_limit_event (status={status}): "
            f"rateLimitType={info.get('rateLimitType')}, "
            f"resetsAt={info.get('resetsAt')}"
        )
        self._debug(
            f"⚠️ rate_limit `{status}` "
            f"(CLI 자체 처리 중, type={info.get('rateLimitType')})"
        )

    def _observe_unknown_event(self, msg_type: str, data: dict) -> None:
        """InstrumentedClaudeClient 콜백: unknown event 관찰"""
        data_summary = str(data)[:200] if data else ""
        logger.warning(f"Unknown event observed: {msg_type} — {data_summary}")

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
                    f"인터벤션 주입: runner={self.runner_id}, "
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
                    f"인터벤션 드레인 주입: runner={self.runner_id}, "
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

        events = self._drain_events()
        for event in events:
            try:
                await on_event(event)
            except Exception as e:
                logger.warning(f"서브에이전트 이벤트 콜백 오류: {e}")

    def _update_client_session_id(self, session_id: str) -> None:
        """MessageProcessor 콜백: 클라이언트 세션 ID 갱신"""
        self._lifecycle._session_id = session_id

    async def _receive_messages(
        self,
        client: "ClaudeSDKClient",
        compact_handler: CompactRetryHandler,
        msg_state: MessageState,
        on_progress: Optional[Callable[[str], Awaitable[None]]],
        on_compact: Optional[Callable[[str, str], Awaitable[None]]],
        on_intervention: Optional[InterventionCallback] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_event: Optional[EventCallback] = None,
    ) -> None:
        """내부 메시지 수신 루프: receive_response()에서 메시지를 읽어 상태 갱신

        인터벤션 폴링은 메시지 수신과 병렬로 실행됩니다.
        Claude API 응답 대기 중에도 INTERVENTION_POLL_INTERVAL 간격으로
        on_intervention 콜백을 폴링하여 사용자 메시지를 즉시 주입합니다.
        """
        runner_id = self.runner_id
        processor = MessageProcessor(
            msg_state=msg_state,
            on_event=on_event,
            on_progress=on_progress,
            on_session=on_session,
            on_client_session_update=self._update_client_session_id,
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
                                aiter.__anext__(), timeout=COMPACT_RETRY_READ_TIMEOUT
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
                        # 타이머만 완료, 메시지 아직 대기 중 → 인터벤션 폴링
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
                        f"Compact retry 읽기 타임아웃 ({COMPACT_RETRY_READ_TIMEOUT}s): "
                        f"runner={runner_id}, retry={compact_handler.retry_count}, "
                        f"pid={self._lifecycle.pid}, cli_alive={self._is_cli_alive()}"
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

    # ---------------------------------------------------------------------------
    # _execute() 헬퍼 메서드들
    # ---------------------------------------------------------------------------

    def _prepare_execution(
        self,
        on_event: Optional[EventCallback] = None,
    ) -> ExecutionContext:
        """실행 전 초기화 로직

        이전 실행의 잔여 상태를 정리하고, 실행 컨텍스트를 생성합니다.

        Args:
            on_event: 이벤트 콜백 (can_use_tool에서 사용)

        Returns:
            ExecutionContext: 실행 컨텍스트
        """
        runner_id = self.runner_id

        # 이전 실행의 잔여 상태 정리 (풀링된 runner 재사용 대비)
        self._pending_events.clear()
        self._input_handler.clear()

        # can_use_tool 콜백에서 사용할 on_event 바인딩
        self._input_handler.bind_event_callback(on_event)

        # 현재 실행 루프를 인스턴스에 등록 (interrupt에서 사용)
        self.execution_loop = asyncio.get_running_loop()

        # 모듈 레지스트리에 등록 (runner_id가 있을 때만)
        if runner_id:
            register_runner(self)

        return ExecutionContext(
            runner_id=runner_id,
            session_start=datetime.now(timezone.utc),
            msg_state=MessageState(),
            compact_handler=CompactRetryHandler(),
        )

    def _finalize_result(self, msg_state: MessageState) -> EngineResult:
        """정상 완료 시 결과 생성 — error_handlers.finalize_result 위임"""
        return _finalize_result_fn(msg_state)

    def _handle_file_not_found(self, e: FileNotFoundError) -> EngineResult:
        """FileNotFoundError 처리 — error_handlers.handle_file_not_found 위임"""
        return _handle_file_not_found_fn(e)

    def _handle_process_error(
        self,
        e: "ProcessError",
        ctx: ExecutionContext,
    ) -> EngineResult:
        """ProcessError 처리 — error_handlers.handle_process_error 위임"""
        return _handle_process_error_fn(
            e,
            ctx,
            pid=self._lifecycle.pid,
            debug_fn=self.debug_send_fn,
            active_clients_count=get_registry_size(),
        )

    def _handle_parse_error(
        self,
        e: "MessageParseError",
        msg_state: MessageState,
    ) -> EngineResult:
        """MessageParseError 처리 — error_handlers.handle_parse_error 위임"""
        return _handle_parse_error_fn(e, msg_state)

    def _handle_unknown_error(
        self,
        e: Exception,
        msg_state: MessageState,
    ) -> EngineResult:
        """알 수 없는 예외 처리 — error_handlers.handle_unknown_error 위임"""
        return _handle_unknown_error_fn(e, msg_state)

    async def _cleanup_execution(self, ctx: ExecutionContext) -> None:
        """실행 후 정리 로직

        Args:
            ctx: 실행 컨텍스트
        """
        if not self._pooled:
            await self._remove_client()
        # pooled 모드: client 유지, registry와 execution_loop만 정리
        self.execution_loop = None
        self._input_handler.unbind_event_callback()
        self._input_handler.clear()
        if ctx.runner_id:
            remove_runner(ctx.runner_id)
        if ctx.stderr_file is not None:
            try:
                ctx.stderr_file.close()
            except Exception:
                pass

    async def run(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        on_compact: Optional[Callable[[str, str], Awaitable[None]]] = None,
        on_intervention: Optional[InterventionCallback] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_event: Optional[EventCallback] = None,
        extra_env: Optional[dict] = None,
    ) -> EngineResult:
        """Claude Code 실행

        Args:
            prompt: 실행할 프롬프트
            session_id: 기존 세션 ID (resume)
            on_progress: 진행 상황 콜백
            on_compact: 컴팩션 이벤트 콜백
            on_intervention: 인터벤션 폴링 콜백.
                호출 시 Optional[str]을 반환하며, 문자열이면 실행 중인
                대화에 새 메시지로 주입됩니다. None이면 대기 중인
                인터벤션이 없는 것으로 처리합니다.
            on_session: 세션 ID 확보 콜백.
                SystemMessage에서 session_id를 추출한 시점에 호출됩니다.
                클라이언트에게 session_id를 조기 통지하는 데 사용합니다.
            on_event: 세분화 이벤트 콜백 (Optional).
                TEXT_DELTA, TOOL_START, TOOL_RESULT, RESULT 이벤트를 받습니다.
                None이면 이벤트를 발행하지 않습니다.

        Returns:
            EngineResult: 엔진 순수 실행 결과.
                응용 마커(UPDATE/RESTART/LIST_RUN) 파싱과
                OM 관찰 트리거는 호출부에서 수행합니다.
        """
        # 세션 ID 사전 검증 (resume 시)
        if session_id:
            validation_error = validate_session(session_id)
            if validation_error:
                logger.warning(f"세션 검증 실패: {validation_error}")
                return EngineResult(
                    success=False,
                    output="",
                    error=validation_error,
                )

        return await self._execute(prompt, session_id, on_progress, on_compact, on_intervention, on_session, on_event, extra_env=extra_env)

    async def _execute(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        on_compact: Optional[Callable[[str, str], Awaitable[None]]] = None,
        on_intervention: Optional[InterventionCallback] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_event: Optional[EventCallback] = None,
        extra_env: Optional[dict] = None,
    ) -> EngineResult:
        """실제 실행 로직 - 오케스트레이션만 담당

        초기화, 에러 처리, 정리 로직은 헬퍼 메서드로 분리되어 있습니다.
        """
        ctx = self._prepare_execution(on_event)
        msg_state = ctx.msg_state
        compact_handler = ctx.compact_handler

        try:
            # _get_or_create_client가 내부에서 _build_options를 호출
            client, ctx.stderr_file = await self._get_or_create_client(
                session_id=session_id,
                compact_events=compact_handler.events,
                extra_env=extra_env,
            )
            logger.info(f"Claude Code SDK 실행 시작 (cwd={self.working_dir})")

            await client.query(prompt)

            # Compact retry 외부 루프:
            # receive_response()는 ResultMessage에서 즉시 return하므로,
            # autocompact가 현재 턴의 ResultMessage를 발생시키면
            # compact 후의 응답을 수신하지 못함.
            # compact 이벤트가 감지되면 receive_response()를 재호출하여
            # post-compact 응답을 계속 수신.
            while True:
                before = compact_handler.snapshot()

                await self._receive_messages(
                    client, compact_handler, msg_state, on_progress, on_compact,
                    on_intervention, on_session, on_event,
                )

                # PreCompact 훅 콜백 실행을 위한 이벤트 루프 양보
                await asyncio.sleep(0)

                # 미통지 compact 이벤트 알림
                await compact_handler.notify_events(on_compact)

                # Compact retry 판정
                if compact_handler.evaluate(
                    msg_state, before,
                    cli_alive=self._is_cli_alive(),
                    pid=self._lifecycle.pid,
                    runner_id=self.runner_id,
                ):
                    msg_state.reset_for_retry()
                    continue

                # 무출력 종료: 로그만 남기고 스레드 덤프는 생략
                if not msg_state.has_result:
                    _dur = (datetime.now(timezone.utc) - ctx.session_start).total_seconds()
                    logger.warning(
                        f"세션 무출력 종료: runner={ctx.runner_id}, "
                        f"duration={_dur:.1f}s, msgs={msg_state.msg_count}"
                    )
                break

            return self._finalize_result(msg_state)

        except FileNotFoundError as e:
            return self._handle_file_not_found(e)
        except ProcessError as e:
            return self._handle_process_error(e, ctx)
        except MessageParseError as e:
            return self._handle_parse_error(e, msg_state)
        except Exception as e:
            return self._handle_unknown_error(e, msg_state)
        finally:
            await self._cleanup_execution(ctx)

    async def compact_session(self, session_id: str) -> EngineResult:
        """세션 컴팩트 처리"""
        if not session_id:
            return EngineResult(
                success=False,
                output="",
                error="세션 ID가 없습니다."
            )

        logger.info(f"세션 컴팩트 시작: {session_id}")
        result = await self._execute("/compact", session_id)

        if result.success:
            logger.info(f"세션 컴팩트 완료: {session_id}")
        else:
            logger.error(f"세션 컴팩트 실패: {session_id}, {result.error}")

        return result
