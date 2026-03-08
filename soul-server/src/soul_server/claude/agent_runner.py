"""Claude Code SDK 기반 실행기"""

import asyncio
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Optional, Callable, Awaitable

import psutil

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
        PermissionResultAllow,
        PermissionResultDeny,
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
    class PermissionResultAllow:
        pass
    class PermissionResultDeny:
        pass
    class ToolPermissionContext:
        pass

from soul_server.claude.diagnostics import (
    DebugSendFn,
    build_session_dump,
    classify_process_error,
    format_rate_limit_warning,
)
from soul_server.engine.types import (
    EngineResult,
    InputRequestEngineEvent,
    InterventionCallback,
    EngineEvent,
    EventCallback,
)
from soul_server.claude.compact_retry import (
    CompactRetryHandler,
    CompactRetryState,  # re-export for backward compat
    COMPACT_RETRY_READ_TIMEOUT,  # re-export
    MAX_COMPACT_RETRIES,  # re-export
    _extract_last_assistant_text,  # re-export
)
from soul_server.claude.hook_builder import build_hooks as _build_hooks_fn
from soul_server.claude.message_processor import MessageProcessor
from soul_server.claude.instrumented_client import InstrumentedClaudeClient
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

    @classmethod
    def from_engine_result(
        cls,
        result: EngineResult,
        markers: Any = None,
    ) -> "ClaudeResult":
        """EngineResult + markers → ClaudeResult 변환

        Args:
            result: 엔진 순수 결과
            markers: 파싱된 응용 마커 (duck-typed, None이면 기본값 사용)
        """
        return cls(
            success=result.success,
            output=result.output,
            session_id=result.session_id,
            error=result.error,
            is_error=result.is_error,
            interrupted=result.interrupted,
            usage=result.usage,
            collected_messages=result.collected_messages,
            update_requested=getattr(markers, "update_requested", False),
            restart_requested=getattr(markers, "restart_requested", False),
            list_run=getattr(markers, "list_run", None),
        )


# ---------------------------------------------------------------------------
# Module-level registry: runner_id → ClaudeRunner
# ---------------------------------------------------------------------------
_registry: dict[str, "ClaudeRunner"] = {}
_registry_lock = threading.Lock()
_shutting_down = False


def get_runner(runner_id: str) -> Optional["ClaudeRunner"]:
    """레지스트리에서 러너 조회"""
    with _registry_lock:
        return _registry.get(runner_id)


def register_runner(runner: "ClaudeRunner") -> bool:
    """레지스트리에 러너 등록

    Args:
        runner: 등록할 ClaudeRunner 인스턴스

    Returns:
        True: 등록 성공
        False: 셧다운 중이라 등록 거부
    """
    with _registry_lock:
        if _shutting_down:
            return False  # 셧다운 중 등록 거부
        _registry[runner.runner_id] = runner
        return True


def reset_shutdown_state() -> None:
    """테스트용: _shutting_down 플래그 초기화"""
    global _shutting_down
    with _registry_lock:
        _shutting_down = False


def remove_runner(runner_id: str) -> Optional["ClaudeRunner"]:
    """레지스트리에서 러너 제거"""
    with _registry_lock:
        return _registry.pop(runner_id, None)


async def shutdown_all() -> int:
    """모든 등록된 러너의 클라이언트를 종료

    프로세스 종료 전에 호출하여 고아 프로세스를 방지합니다.
    셧다운 시작 후 새 러너 등록은 거부됩니다.

    Returns:
        종료된 클라이언트 수
    """
    global _shutting_down

    with _registry_lock:
        _shutting_down = True
        runners = list(_registry.values())
        _registry.clear()

    if not runners:
        logger.info("종료할 활성 클라이언트 없음")
        return 0

    count = 0
    for runner in runners:
        try:
            if runner.client:
                await runner.client.disconnect()
                count += 1
                logger.info(f"클라이언트 종료 성공: runner={runner.runner_id}")
        except Exception as e:
            logger.warning(f"클라이언트 종료 실패: runner={runner.runner_id}, {e}")
            if runner.pid:
                ClaudeRunner._force_kill_process(runner.pid, runner.runner_id)
                count += 1

    logger.info(f"총 {count}개 클라이언트 종료 완료")
    return count


def shutdown_all_sync() -> int:
    """모든 등록된 러너의 클라이언트를 종료 (동기 버전)

    시그널 핸들러 등 동기 컨텍스트에서 사용합니다.

    Returns:
        종료된 클라이언트 수
    """
    try:
        loop = asyncio.new_event_loop()
        count = loop.run_until_complete(shutdown_all())
        loop.close()
        return count
    except Exception as e:
        logger.warning(f"클라이언트 동기 종료 중 오류: {e}")
        return 0


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
    ):
        import uuid as _uuid
        self.runner_id = _uuid.uuid4().hex[:8]
        self.working_dir = working_dir or Path.cwd()
        self.allowed_tools = allowed_tools  # None means no restriction
        self.disallowed_tools = disallowed_tools or DEFAULT_DISALLOWED_TOOLS
        self.mcp_config_path = mcp_config_path
        self.debug_send_fn = debug_send_fn
        self._pooled = pooled

        # Rate limit tracking
        self.rate_limit_tracker = None  # RateLimitTracker instance (injected by adapter)
        self.alert_send_fn: Optional[Callable] = None  # credential_alert 전송 콜백

        # Instance-level client state
        self.client: Optional[ClaudeSDKClient] = None
        self.pid: Optional[int] = None
        self.execution_loop: Optional[asyncio.AbstractEventLoop] = None
        # 현재 클라이언트가 연결된 세션 ID (세션 불일치 감지용)
        self._client_session_id: Optional[str] = None
        # 현재 클라이언트의 옵션 핑거프린트 (설정 불일치 감지용)
        self._client_options_fp: Optional[str] = None

        # Subagent 추적을 위한 상태
        self._pending_events: deque[EngineEvent] = deque()  # 이벤트 큐
        # NOTE: SDK 한계로 SubagentStart에서 parent의 toolu_* ID를 획득할 수 없음.
        # PreToolUse는 toolu_* ID를, SubagentStart는 random UUID를 전달하며,
        # Task 도구는 isConcurrencySafe=true라 병렬 실행 시 순서 보장 불가.
        # → parent_event_id를 빈 문자열로 전달, 대시보드가 턴 루트에 연결.

        # AskUserQuestion 응답 대기용
        # request_id → asyncio.Event (응답 도착 알림)
        self._input_response_events: dict[str, asyncio.Event] = {}
        # request_id → 응답 데이터 (answers dict)
        self._input_responses: dict[str, dict] = {}
        # AskUserQuestion 응답 대기 타임아웃 (초)
        self.input_request_timeout: float = 300.0
        # can_use_tool 콜백에서 직접 이벤트를 발행하기 위한 런타임 콜백
        # _execute()에서 on_event가 설정되면 여기에 바인딩됩니다.
        self._on_event_callback: Optional[EventCallback] = None

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

    @staticmethod
    def _compute_options_fingerprint(options) -> Optional[str]:
        """options의 핵심 설정을 해싱하여 fingerprint를 생성

        setting_sources, allowed_tools, disallowed_tools의 조합으로
        클라이언트 설정 불일치를 감지합니다.
        """
        if options is None:
            return None
        import hashlib
        key_parts = (
            str(getattr(options, "setting_sources", None)),
            str(sorted(getattr(options, "allowed_tools", None) or [])),
            str(sorted(getattr(options, "disallowed_tools", None) or [])),
        )
        return hashlib.md5("|".join(key_parts).encode()).hexdigest()[:8]

    def _drain_events(self) -> list[EngineEvent]:
        """큐의 모든 이벤트를 반환하고 비움"""
        events = list(self._pending_events)
        self._pending_events.clear()
        return events

    async def _get_or_create_client(
        self,
        session_id: Optional[str] = None,
        compact_events: Optional[list] = None,
    ) -> tuple[ClaudeSDKClient, Optional["IO[str]"]]:
        """ClaudeSDKClient를 가져오거나 새로 생성

        내부에서 _build_options()를 호출하여 옵션을 생성합니다.
        웜업과 실행 모두 이 메서드를 통해 클라이언트를 생성하므로
        동일한 옵션 빌드 경로를 보장합니다.

        불일치 감지:
        1. 세션 불일치: 기존 클라이언트의 세션과 요청 세션이 다른 경우
           - requested_session이 None이고 기존 세션이 있으면 오염 방지를 위해 재생성
           - requested_session이 있는데 기존 세션과 다르면 재생성
        2. 설정 불일치: MCP 서버, 허용/금지 도구 설정이 다른 경우

        Returns:
            (client, stderr_file) - stderr_file은 호출자가 닫아야 함
        """
        options, stderr_file = self._build_options(session_id, compact_events)
        # HIGH-3: 프로덕션에서는 디버그 로깅 억제
        # logger.isEnabledFor(DEBUG)로 문자열 포맷팅 비용도 회피
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"[OPTIONS] permission_mode={options.permission_mode}")
            logger.debug(f"[OPTIONS] cwd={options.cwd}")
            logger.debug(f"[OPTIONS] resume={options.resume}")
            logger.debug(f"[OPTIONS] allowed_tools count={len(options.allowed_tools) if options.allowed_tools else 0}")
            logger.debug(f"[OPTIONS] disallowed_tools count={len(options.disallowed_tools) if options.disallowed_tools else 0}")
            logger.debug(f"[OPTIONS] hooks={'yes' if options.hooks else 'no'}")
        requested_session = session_id
        requested_fp = self._compute_options_fingerprint(options)

        if self.client is not None:
            session_mismatch = self._client_session_id != requested_session
            config_mismatch = (
                requested_fp is not None
                and self._client_options_fp is not None
                and requested_fp != self._client_options_fp
            )

            if session_mismatch or config_mismatch:
                logger.info(
                    f"[DEBUG-CLIENT] 클라이언트 불일치 감지: "
                    f"session_mismatch={session_mismatch} "
                    f"(current={self._client_session_id}, requested={requested_session}), "
                    f"config_mismatch={config_mismatch} "
                    f"(current_fp={self._client_options_fp}, requested_fp={requested_fp}) "
                    f"→ 클라이언트 재생성, runner={self.runner_id}"
                )
                await self._remove_client()
                # _remove_client() 후 self.client = None이 되므로 아래 생성 로직으로 진행
            else:
                logger.info(f"[DEBUG-CLIENT] 기존 클라이언트 재사용: runner={self.runner_id}")
                return self.client, stderr_file

        import time as _time
        logger.info(f"[DEBUG-CLIENT] 새 InstrumentedClaudeClient 생성 시작: runner={self.runner_id}")
        client = InstrumentedClaudeClient(
            options=options,
            on_rate_limit=self._observe_rate_limit,
            on_unknown_event=self._observe_unknown_event,
        )
        logger.info(f"[DEBUG-CLIENT] InstrumentedClaudeClient 인스턴스 생성 완료, connect() 호출...")
        t0 = _time.monotonic()
        try:
            await client.connect()
            elapsed = _time.monotonic() - t0
            logger.info(f"[DEBUG-CLIENT] connect() 성공: {elapsed:.2f}s")
        except Exception as e:
            elapsed = _time.monotonic() - t0
            logger.error(f"[DEBUG-CLIENT] connect() 실패: {elapsed:.2f}s, error={e}")
            try:
                await client.disconnect()
            except Exception:
                pass
            raise

        # subprocess PID 추출
        pid: Optional[int] = None
        try:
            transport = getattr(client, "_transport", None)
            if transport:
                process = getattr(transport, "_process", None)
                if process:
                    pid = getattr(process, "pid", None)
                    if pid:
                        logger.info(f"[DEBUG-CLIENT] subprocess PID 추출: {pid}")
        except Exception as e:
            logger.warning(f"[DEBUG-CLIENT] PID 추출 실패 (무시): {e}")

        self.client = client
        self.pid = pid
        self._client_session_id = requested_session
        self._client_options_fp = requested_fp
        logger.info(
            f"ClaudeSDKClient 생성: runner={self.runner_id}, pid={pid}, "
            f"session={requested_session}, options_fp={requested_fp}"
        )
        return client, stderr_file

    async def _remove_client(self) -> None:
        """이 러너의 ClaudeSDKClient를 정리"""
        client = self.client
        pid = self.pid
        self.client = None
        self.pid = None
        self._client_session_id = None
        self._client_options_fp = None

        if client is None:
            return

        try:
            await client.disconnect()
            logger.info(f"ClaudeSDKClient 정상 종료: runner={self.runner_id}")
        except Exception as e:
            logger.warning(f"ClaudeSDKClient disconnect 실패: runner={self.runner_id}, {e}")
            if pid:
                self._force_kill_process(pid, self.runner_id)

    def detach_client(self) -> Optional[ClaudeSDKClient]:
        """풀이 runner를 회수할 때 client/pid를 안전하게 분리

        _remove_client()와 달리 disconnect를 호출하지 않습니다.
        반환된 client는 풀이 보유하여 재사용합니다.

        Returns:
            분리된 ClaudeSDKClient (없으면 None)
        """
        client = self.client
        self.client = None
        self.pid = None
        self._client_session_id = None
        self._client_options_fp = None
        return client

    def is_idle(self) -> bool:
        """client가 연결되어 있고 현재 실행 중이 아닌지 확인

        Returns:
            True이면 풀에서 재사용 가능한 상태
        """
        if self.client is None:
            return False
        if self.execution_loop is not None and self.execution_loop.is_running():
            return False
        return True

    @staticmethod
    def _force_kill_process(pid: int, runner_id: str) -> None:
        """psutil을 사용하여 프로세스를 강제 종료"""
        try:
            proc = psutil.Process(pid)
            proc.terminate()
            try:
                proc.wait(timeout=3)
                logger.info(f"프로세스 강제 종료 성공 (terminate): PID {pid}, runner={runner_id}")
            except psutil.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
                logger.info(f"프로세스 강제 종료 성공 (kill): PID {pid}, runner={runner_id}")
        except psutil.NoSuchProcess:
            logger.info(f"프로세스 이미 종료됨: PID {pid}, runner={runner_id}")
        except Exception as kill_error:
            logger.error(f"프로세스 강제 종료 실패: PID {pid}, runner={runner_id}, {kill_error}")

    def _is_cli_alive(self) -> bool:
        """CLI 서브프로세스가 아직 살아있는지 확인"""
        if not isinstance(self.pid, int):
            return False
        try:
            proc = psutil.Process(self.pid)
            return proc.is_running()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    def interrupt(self) -> bool:
        """이 러너에 인터럽트 전송 (동기)"""
        client = self.client
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
        """외부에서 AskUserQuestion 응답을 전달

        API 엔드포인트에서 호출합니다.
        can_use_tool 콜백이 이 응답을 수신하여 SDK에 전달합니다.

        Args:
            request_id: input_request 이벤트의 request_id
            answers: 질문별 응답 dict

        Returns:
            True: 대기 중인 요청이 있어 응답 전달 성공
            False: 대기 중인 요청 없음
        """
        event = self._input_response_events.get(request_id)
        if event is None:
            return False
        self._input_responses[request_id] = answers
        event.set()
        return True

    def _make_can_use_tool(self):
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
        import uuid as _uuid

        async def can_use_tool(tool_name, tool_input, context):
            if tool_name != "AskUserQuestion":
                return PermissionResultAllow()

            request_id = _uuid.uuid4().hex[:12]
            questions = tool_input.get("questions", [])

            logger.info(
                f"[ASK_USER] AskUserQuestion 감지: "
                f"runner={self.runner_id}, request_id={request_id}, "
                f"questions={len(questions)}"
            )

            # InputRequestEngineEvent를 직접 발행
            event = InputRequestEngineEvent(
                request_id=request_id,
                tool_use_id="",
                questions=questions,
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
                self._pending_events.append(event)

            # 응답 대기용 Event 생성
            response_event = asyncio.Event()
            self._input_response_events[request_id] = response_event

            try:
                # 응답 대기 (타임아웃 포함)
                try:
                    await asyncio.wait_for(
                        response_event.wait(),
                        timeout=self.input_request_timeout,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        f"[ASK_USER] 응답 타임아웃: "
                        f"runner={self.runner_id}, request_id={request_id}"
                    )
                    return PermissionResultDeny(
                        message="사용자 응답 대기 시간이 초과되었습니다."
                    )

                # 응답 수신
                answers = self._input_responses.get(request_id, {})
                logger.info(
                    f"[ASK_USER] 응답 수신: "
                    f"runner={self.runner_id}, request_id={request_id}, "
                    f"answers={answers}"
                )

                # updated_input 구성: 원본 questions + answers
                updated_input = dict(tool_input)
                updated_input["answers"] = answers

                return PermissionResultAllow(updated_input=updated_input)
            finally:
                # 정리
                self._input_response_events.pop(request_id, None)
                self._input_responses.pop(request_id, None)

        return can_use_tool

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
        logger.debug(f"Unknown event observed: {msg_type}")

    def _build_options(
        self,
        session_id: Optional[str] = None,
        compact_events: Optional[list] = None,
    ) -> tuple[ClaudeAgentOptions, Optional[IO[str]]]:
        """ClaudeAgentOptions와 stderr 파일을 반환합니다.

        Args:
            session_id: 재개할 세션 ID
            compact_events: 컴팩션 이벤트 목록

        Returns:
            (options, stderr_file)
            - stderr_file은 호출자가 닫아야 함 (sys.stderr이면 None)
        """
        runner_id = self.runner_id
        hooks = _build_hooks_fn(compact_events, self._pending_events)

        # CLI stderr를 세션별 파일에 캡처
        import sys as _sys
        _runtime_dir = Path(__file__).resolve().parents[4]
        _stderr_suffix = runner_id or "default"
        _stderr_log_path = _runtime_dir / "logs" / f"cli_stderr_{_stderr_suffix}.log"
        logger.info(f"[DEBUG] CLI stderr 로그 경로: {_stderr_log_path}")
        _stderr_file = None
        _stderr_target = _sys.stderr
        try:
            _stderr_file = open(_stderr_log_path, "a", encoding="utf-8")
            _stderr_file.write(f"\n--- CLI stderr capture start: {datetime.now(timezone.utc).isoformat()} ---\n")
            _stderr_file.flush()
            _stderr_target = _stderr_file
        except Exception as _e:
            logger.warning(f"[DEBUG] stderr 캡처 파일 열기 실패: {_e}")
            if _stderr_file:
                _stderr_file.close()
            _stderr_file = None

        # setting_sources로 프로젝트 설정(.mcp.json)을 자동 발견
        # 웜업과 실행 모두 동일한 경로를 사용하여 fingerprint 일치 보장
        logger.info(
            f"[BUILD_OPTIONS] runner={runner_id}, "
            f"setting_sources=['project'], "
            f"session_id={session_id}, "
            f"allowed_tools={self.allowed_tools}"
        )

        options = ClaudeAgentOptions(
            allowed_tools=self.allowed_tools,
            disallowed_tools=self.disallowed_tools,
            permission_mode="bypassPermissions",
            can_use_tool=self._make_can_use_tool(),
            cwd=self.working_dir,
            setting_sources=["project"],
            hooks=hooks,
            extra_args={"debug-to-stderr": None},
            debug_stderr=_stderr_target,
        )

        if session_id:
            options.resume = session_id

        return options, _stderr_file

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
        self._client_session_id = session_id

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
                        f"pid={self.pid}, cli_alive={self._is_cli_alive()}"
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
        self._input_response_events.clear()
        self._input_responses.clear()

        # can_use_tool 콜백에서 사용할 on_event 바인딩
        self._on_event_callback = on_event

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
        """정상 완료 시 결과 생성

        Args:
            msg_state: 메시지 상태

        Returns:
            EngineResult: 엔진 실행 결과
        """
        output = msg_state.result_text or msg_state.current_text

        return EngineResult(
            success=not msg_state.is_error,
            output=output,
            session_id=msg_state.session_id,
            collected_messages=msg_state.collected_messages,
            is_error=msg_state.is_error,
            usage=msg_state.usage,
        )

    def _handle_file_not_found(self, e: FileNotFoundError) -> EngineResult:
        """FileNotFoundError 처리

        Args:
            e: FileNotFoundError 예외

        Returns:
            EngineResult: 에러 결과
        """
        logger.error(f"Claude Code CLI를 찾을 수 없습니다: {e}")
        return EngineResult(
            success=False,
            output="",
            error="Claude Code CLI를 찾을 수 없습니다. claude 명령어가 PATH에 있는지 확인하세요."
        )

    def _handle_process_error(
        self,
        e: "ProcessError",
        ctx: ExecutionContext,
    ) -> EngineResult:
        """ProcessError 처리

        Args:
            e: ProcessError 예외
            ctx: 실행 컨텍스트

        Returns:
            EngineResult: 에러 결과
        """
        msg_state = ctx.msg_state
        friendly_msg = classify_process_error(e)
        logger.error(
            f"Claude Code CLI 프로세스 오류: exit_code={e.exit_code}, "
            f"stderr={e.stderr}, friendly={friendly_msg}"
        )
        _dur = (datetime.now(timezone.utc) - ctx.session_start).total_seconds()
        dump = build_session_dump(
            reason="ProcessError",
            pid=self.pid,
            duration_sec=_dur,
            message_count=msg_state.msg_count,
            last_tool="",
            current_text_len=len(msg_state.current_text),
            result_text_len=len(msg_state.result_text),
            session_id=msg_state.session_id,
            exit_code=e.exit_code,
            error_detail=str(e.stderr or e),
            active_clients_count=len(_registry),
            runner_id=ctx.runner_id,
        )
        self._debug(dump)
        return EngineResult(
            success=False,
            output=msg_state.current_text,
            session_id=msg_state.session_id,
            error=friendly_msg,
        )

    def _handle_parse_error(
        self,
        e: "MessageParseError",
        msg_state: MessageState,
    ) -> EngineResult:
        """MessageParseError 처리

        Args:
            e: MessageParseError 예외
            msg_state: 메시지 상태

        Returns:
            EngineResult: 에러 결과
        """
        action, msg_type = classify_parse_error(e.data, log_fn=logger)

        if msg_type == "rate_limit_event":
            logger.warning(f"rate_limit_event (외부 catch): {e}")
            return EngineResult(
                success=False,
                output=msg_state.current_text,
                session_id=msg_state.session_id,
                error="사용량 제한에 도달했습니다. 잠시 후 다시 시도해주세요.",
            )

        if action is ParseAction.CONTINUE:
            # unknown type이 외부까지 전파된 경우
            logger.warning(f"Unknown message type escaped loop: {msg_type}")
            return EngineResult(
                success=False,
                output=msg_state.current_text,
                session_id=msg_state.session_id,
                error=f"알 수 없는 메시지 타입: {msg_type}",
            )

        logger.exception(f"SDK 메시지 파싱 오류: {e}")
        return EngineResult(
            success=False,
            output=msg_state.current_text,
            session_id=msg_state.session_id,
            error="Claude 응답 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        )

    def _handle_unknown_error(
        self,
        e: Exception,
        msg_state: MessageState,
    ) -> EngineResult:
        """알 수 없는 예외 처리

        Args:
            e: Exception 예외
            msg_state: 메시지 상태

        Returns:
            EngineResult: 에러 결과
        """
        logger.exception(f"Claude Code SDK 실행 오류: {e}")
        return EngineResult(
            success=False,
            output=msg_state.current_text,
            session_id=msg_state.session_id,
            error=str(e)
        )

    async def _cleanup_execution(self, ctx: ExecutionContext) -> None:
        """실행 후 정리 로직

        Args:
            ctx: 실행 컨텍스트
        """
        if not self._pooled:
            await self._remove_client()
        # pooled 모드: client 유지, registry와 execution_loop만 정리
        self.execution_loop = None
        self._on_event_callback = None
        # 미응답 input_request 정리 (타임아웃 중인 콜백이 있으면 깨움)
        for evt in self._input_response_events.values():
            evt.set()
        self._input_response_events.clear()
        self._input_responses.clear()
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

        return await self._execute(prompt, session_id, on_progress, on_compact, on_intervention, on_session, on_event)

    async def _execute(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        on_compact: Optional[Callable[[str, str], Awaitable[None]]] = None,
        on_intervention: Optional[InterventionCallback] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_event: Optional[EventCallback] = None,
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
                    pid=self.pid,
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



# 테스트용
async def main():
    runner = ClaudeRunner()
    result = await runner.run("안녕? 간단히 인사해줘. 3줄 이내로.")
    print(f"Success: {result.success}")
    print(f"Session ID: {result.session_id}")
    print(f"Output:\n{result.output}")
    if result.error:
        print(f"Error: {result.error}")


if __name__ == "__main__":
    asyncio.run(main())
