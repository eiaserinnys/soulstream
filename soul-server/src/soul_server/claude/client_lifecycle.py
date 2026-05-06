"""Claude SDK 클라이언트 라이프사이클 관리

ClaudeSDKClient의 생성, 연결, 재사용 판정, 분리, 정리를 담당한다.
ClaudeRunner는 이 모듈을 composition으로 소유하여 자신의 실행 루프 관심사와
SDK 클라이언트 라이프사이클 관심사를 분리한다.

지식 경계:
- ClaudeRunner에 대해 알지 않는다. 필요한 값은 생성자로 주입받는다.
- 실행 중 여부(is_idle)는 호출자가 `is_execution_running: bool`로 넘긴다.
"""

import asyncio
import hashlib
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Callable, Optional

import psutil

try:
    from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False
    class ClaudeAgentOptions:  # type: ignore[no-redef]
        pass
    class ClaudeSDKClient:  # type: ignore[no-redef]
        pass

from soul_server.claude.instrumented_client import InstrumentedClaudeClient

logger = logging.getLogger(__name__)


async def _client_lifecycle_task(
    client: "ClaudeSDKClient",
    ready_event: asyncio.Event,
    shutdown_event: asyncio.Event,
    runner_id: str,
) -> None:
    """client.connect()와 disconnect()를 동일 asyncio 태스크에서 실행.

    claude_agent_sdk 내부의 anyio TaskGroup은 __aenter__를 호출한 태스크와
    __aexit__를 호출하는 태스크가 동일해야 한다. runner_pool의 maintenance task가
    connect()를 호출하고 session task가 disconnect()를 호출하면 anyio CancelScope의
    _deliver_cancellation이 무한 루프에 빠져 CPU busy loop을 유발한다.

    이 함수를 asyncio.create_task()로 실행하면 connect()와 disconnect()가 같은
    태스크에서 실행되므로 anyio cross-task 위반이 발생하지 않는다.

    Args:
        client: 연결할 ClaudeSDKClient
        ready_event: connect() 완료(성공 또는 실패) 시 set되는 이벤트
        shutdown_event: disconnect()를 트리거하기 위해 외부에서 set하는 이벤트
        runner_id: 로깅용 러너 ID
    """
    try:
        await client.connect()
    except BaseException:
        # connect() 실패 — ready_event를 set하여 호출자에게 알림.
        # re-raise하여 태스크에 예외를 저장 (호출자가 task.exception()으로 확인).
        ready_event.set()
        raise

    ready_event.set()
    logger.debug(f"[LIFECYCLE] connect() 완료, shutdown 대기: runner={runner_id}")

    await shutdown_event.wait()

    logger.debug(f"[LIFECYCLE] shutdown_event 수신, disconnect() 호출: runner={runner_id}")
    try:
        await client.disconnect()
        logger.info(f"[LIFECYCLE] disconnect() 완료: runner={runner_id}")
    except Exception as e:
        logger.warning(f"[LIFECYCLE] disconnect() 실패: runner={runner_id}, {e}")


def compute_options_fingerprint(options) -> Optional[str]:
    """options의 핵심 설정을 해싱하여 fingerprint를 생성.

    setting_sources, allowed_tools, disallowed_tools의 조합으로
    클라이언트 설정 불일치를 감지한다.
    """
    if options is None:
        return None
    key_parts = (
        str(getattr(options, "setting_sources", None)),
        str(sorted(getattr(options, "allowed_tools", None) or [])),
        str(sorted(getattr(options, "disallowed_tools", None) or [])),
    )
    return hashlib.md5("|".join(key_parts).encode()).hexdigest()[:8]


def force_kill_process(pid: int, runner_id: str) -> None:
    """psutil을 사용하여 프로세스를 강제 종료."""
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


class ClientLifecycle:
    """ClaudeSDKClient 라이프사이클 관리.

    ClaudeRunner가 composition으로 소유한다. Runner의 execution_loop나
    input_handler 등에는 접근하지 않으며, 필요한 콜백은 모두 생성자 인자로 받는다.

    Attributes:
        client: 현재 연결된 ClaudeSDKClient (없으면 None)
        pid: subprocess PID (없으면 None)

    내부 상태:
        _session_id: 현재 클라이언트가 연결된 세션 ID
        _options_fp: 현재 클라이언트의 options fingerprint
        _lifecycle_task: connect/disconnect 래퍼 태스크
        _shutdown_event: 태스크에 disconnect 트리거를 보내는 이벤트
    """

    def __init__(
        self,
        *,
        runner_id: str,
        working_dir: Path,
        model: Optional[str],
        system_prompt: Optional[str],
        max_turns: Optional[int],
        allowed_tools: Optional[list[str]],
        disallowed_tools: Optional[list[str]],
        mcp_config_path: Optional[Path],
        hooks_factory: Callable[[Optional[list]], Any],
        can_use_tool_factory: Callable[[], Any],
        rate_limit_observer: Callable[[dict], None],
        unknown_event_observer: Callable[[str, dict], None],
        force_kill_fn: Optional[Callable[[int, str], None]] = None,
    ):
        """
        Args:
            runner_id: 러너 식별자 (로깅/stderr 파일명용)
            working_dir: Claude Code 실행 cwd
            model: 모델 이름 (None 허용)
            system_prompt: 시스템 프롬프트 (None 허용)
            max_turns: 최대 턴 수 (None 허용)
            allowed_tools: 허용 도구 목록 (None 허용)
            disallowed_tools: 금지 도구 목록
            mcp_config_path: MCP 설정 경로 (현재 직접 참조는 없음, 향후 확장용)
            hooks_factory: compact_events를 받아 hooks dict를 반환하는 팩토리
            can_use_tool_factory: can_use_tool 콜백을 반환하는 팩토리
            rate_limit_observer: InstrumentedClaudeClient의 on_rate_limit 콜백
            unknown_event_observer: InstrumentedClaudeClient의 on_unknown_event 콜백
            force_kill_fn: 프로세스 강제 종료 함수 (테스트에서 주입 가능).
                None이면 기본 force_kill_process를 사용.
        """
        self.runner_id = runner_id
        self.working_dir = working_dir
        self.model = model
        self.system_prompt = system_prompt
        self.max_turns = max_turns
        self.allowed_tools = allowed_tools
        self.disallowed_tools = disallowed_tools
        self.mcp_config_path = mcp_config_path
        self._hooks_factory = hooks_factory
        self._can_use_tool_factory = can_use_tool_factory
        self._rate_limit_observer = rate_limit_observer
        self._unknown_event_observer = unknown_event_observer
        self._force_kill_fn = force_kill_fn or force_kill_process

        # Client state
        self.client: Optional[ClaudeSDKClient] = None
        self.pid: Optional[int] = None
        self._session_id: Optional[str] = None
        self._options_fp: Optional[str] = None
        self._lifecycle_task: Optional[asyncio.Task] = None
        self._shutdown_event: Optional[asyncio.Event] = None

    def build_options(
        self,
        session_id: Optional[str] = None,
        compact_events: Optional[list] = None,
        extra_env: Optional[dict] = None,
    ) -> tuple["ClaudeAgentOptions", Optional[IO[str]]]:
        """ClaudeAgentOptions와 stderr 파일 핸들을 생성한다.

        Args:
            session_id: 재개할 세션 ID
            compact_events: 컴팩션 이벤트 목록
            extra_env: 추가 환경변수

        Returns:
            (options, stderr_file)
            - stderr_file은 호출자가 닫아야 함 (sys.stderr이면 None)
        """
        runner_id = self.runner_id
        hooks = self._hooks_factory(compact_events)

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
            allowed_tools=self.allowed_tools or [],
            disallowed_tools=self.disallowed_tools or [],
            permission_mode="bypassPermissions",
            can_use_tool=self._can_use_tool_factory(),
            cwd=self.working_dir,
            setting_sources=["project"],
            hooks=hooks,
            extra_args={"debug-to-stderr": None},
            debug_stderr=_stderr_target,
            max_buffer_size=50 * 1024 * 1024,  # 50MB: 기본값 1MB가 대형 응답에서 오버플로우 발생
            model=self.model,
            system_prompt=self.system_prompt,
            max_turns=self.max_turns,
            # CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1: CLI가 turn 직후 emit하는
            # prompt_suggestion 메시지를 활성화 (Phase 2 — 프로젝트 기본값).
            # extra_env가 같은 키를 명시적으로 넘기면 그쪽이 우선.
            env={"CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "1", **(extra_env or {})},
        )

        if session_id:
            options.resume = session_id

        return options, _stderr_file

    async def get_or_create(
        self,
        session_id: Optional[str] = None,
        compact_events: Optional[list] = None,
        extra_env: Optional[dict] = None,
        build_options_fn: Optional[
            Callable[..., tuple["ClaudeAgentOptions", Optional[IO[str]]]]
        ] = None,
    ) -> tuple["ClaudeSDKClient", Optional[IO[str]]]:
        """ClaudeSDKClient를 가져오거나 새로 생성한다.

        내부에서 build_options()를 호출하여 옵션을 생성한다.
        웜업과 실행 모두 이 메서드를 통해 클라이언트를 생성하므로
        동일한 옵션 빌드 경로를 보장한다.

        불일치 감지:
        1. 세션 불일치: 기존 클라이언트의 세션과 요청 세션이 다르면 재생성.
        2. 설정 불일치: MCP 서버, 허용/금지 도구 설정이 다르면 재생성.

        Args:
            build_options_fn: 옵션 빌드 함수 (Runner의 _build_options로 위임 가능).
                None이면 self.build_options 사용. Runner가 _build_options를
                오버라이드할 수 있도록 하는 hook 포인트.

        Returns:
            (client, stderr_file) - stderr_file은 호출자가 닫아야 함
        """
        _build = build_options_fn or self.build_options
        options, stderr_file = _build(session_id, compact_events, extra_env=extra_env)
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"[OPTIONS] permission_mode={options.permission_mode}")
            logger.debug(f"[OPTIONS] cwd={options.cwd}")
            logger.debug(f"[OPTIONS] resume={options.resume}")
            logger.debug(f"[OPTIONS] allowed_tools count={len(options.allowed_tools) if options.allowed_tools else 0}")
            logger.debug(f"[OPTIONS] disallowed_tools count={len(options.disallowed_tools) if options.disallowed_tools else 0}")
            logger.debug(f"[OPTIONS] hooks={'yes' if options.hooks else 'no'}")

        requested_session = session_id
        requested_fp = compute_options_fingerprint(options)

        if self.client is not None:
            session_mismatch = self._session_id != requested_session
            config_mismatch = (
                requested_fp is not None
                and self._options_fp is not None
                and requested_fp != self._options_fp
            )

            if session_mismatch or config_mismatch:
                logger.info(
                    f"[DEBUG-CLIENT] 클라이언트 불일치 감지: "
                    f"session_mismatch={session_mismatch} "
                    f"(current={self._session_id}, requested={requested_session}), "
                    f"config_mismatch={config_mismatch} "
                    f"(current_fp={self._options_fp}, requested_fp={requested_fp}) "
                    f"→ 클라이언트 재생성, runner={self.runner_id}"
                )
                await self.remove()
                # remove() 후 self.client = None이 되므로 아래 생성 로직으로 진행
            else:
                logger.info(f"[DEBUG-CLIENT] 기존 클라이언트 재사용: runner={self.runner_id}")
                return self.client, stderr_file

        logger.info(f"[DEBUG-CLIENT] 새 InstrumentedClaudeClient 생성 시작: runner={self.runner_id}")
        client = InstrumentedClaudeClient(
            options=options,
            on_rate_limit=self._rate_limit_observer,
            on_unknown_event=self._unknown_event_observer,
        )
        logger.info("[DEBUG-CLIENT] InstrumentedClaudeClient 인스턴스 생성 완료, lifecycle task 시작...")
        t0 = time.monotonic()

        # Lifecycle task 생성: connect()와 disconnect()를 동일 asyncio 태스크에서 실행.
        # anyio TaskGroup은 __aenter__ 호출 태스크와 __aexit__ 호출 태스크가 동일해야 한다.
        ready_event = asyncio.Event()
        shutdown_event = asyncio.Event()
        lifecycle_task = asyncio.create_task(
            _client_lifecycle_task(client, ready_event, shutdown_event, self.runner_id),
            name=f"lifecycle-{self.runner_id}",
        )

        try:
            await asyncio.wait_for(ready_event.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            lifecycle_task.cancel()
            try:
                await lifecycle_task
            except (asyncio.CancelledError, Exception):
                pass
            elapsed = time.monotonic() - t0
            logger.error(f"[DEBUG-CLIENT] connect() 타임아웃: {elapsed:.2f}s")
            raise TimeoutError(f"ClaudeSDKClient connect() 타임아웃: runner={self.runner_id}")

        elapsed = time.monotonic() - t0

        # connect() 실패 여부 확인: lifecycle task가 이미 종료됐으면 connect()에서 예외 발생
        if lifecycle_task.done():
            exc = lifecycle_task.exception() if not lifecycle_task.cancelled() else None
            if exc is not None:
                logger.error(f"[DEBUG-CLIENT] connect() 실패: {elapsed:.2f}s, error={exc}")
            else:
                logger.error(f"[DEBUG-CLIENT] lifecycle task 조기 종료: {elapsed:.2f}s")
            await lifecycle_task  # 원본 traceback 보존하여 re-raise; 정상 종료면 None 반환
            raise RuntimeError(f"lifecycle task 조기 종료: runner={self.runner_id}")

        logger.info(f"[DEBUG-CLIENT] connect() 성공: {elapsed:.2f}s")

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
        self._session_id = requested_session
        self._options_fp = requested_fp
        self._lifecycle_task = lifecycle_task
        self._shutdown_event = shutdown_event
        logger.info(
            f"ClaudeSDKClient 생성: runner={self.runner_id}, pid={pid}, "
            f"session={requested_session}, options_fp={requested_fp}"
        )
        return client, stderr_file

    async def remove(self) -> None:
        """연결된 ClaudeSDKClient를 정리한다."""
        client = self.client
        pid = self.pid
        lifecycle_task = self._lifecycle_task
        shutdown_event = self._shutdown_event

        self.client = None
        self.pid = None
        self._session_id = None
        self._options_fp = None
        self._lifecycle_task = None
        self._shutdown_event = None

        if client is None:
            return

        if lifecycle_task is not None and shutdown_event is not None:
            # Lifecycle task 경유 종료: shutdown_event를 set하면 lifecycle task가
            # disconnect()를 호출한다. connect()와 동일한 asyncio 태스크에서 실행되므로
            # anyio cross-task 위반이 발생하지 않는다.
            #
            # asyncio.shield + wait_for 대신 asyncio.wait를 사용한다.
            # wait_for(shield(task))는 타임아웃 시 shield 래퍼만 취소하고
            # 원본 태스크를 백그라운드에 남겨 orphan task를 유발한다.
            shutdown_event.set()
            done, _ = await asyncio.wait({lifecycle_task}, timeout=30.0)
            if done:
                try:
                    await lifecycle_task  # 예외가 있으면 꺼냄; traceback 보존
                    logger.info(f"ClaudeSDKClient 정상 종료 (lifecycle): runner={self.runner_id}")
                except Exception as e:
                    logger.warning(
                        f"ClaudeSDKClient lifecycle task 종료 실패: runner={self.runner_id}, {e}"
                    )
            else:
                logger.warning(
                    f"ClaudeSDKClient disconnect 타임아웃, 강제 취소: runner={self.runner_id}"
                )
                lifecycle_task.cancel()
                try:
                    await lifecycle_task
                except (asyncio.CancelledError, Exception):
                    pass
        else:
            # 직접 disconnect (lifecycle task 없음, 하위 호환)
            try:
                await client.disconnect()
                logger.info(f"ClaudeSDKClient 정상 종료: runner={self.runner_id}")
            except Exception as e:
                logger.warning(f"ClaudeSDKClient disconnect 실패: runner={self.runner_id}, {e}")

        if pid:
            self._force_kill_fn(pid, self.runner_id)

    def detach(self) -> Optional["ClaudeSDKClient"]:
        """풀이 runner를 회수할 때 client/pid를 안전하게 분리한다.

        remove()와 달리 disconnect를 호출하지 않는다.
        반환된 client는 풀이 보유하여 재사용한다.

        lifecycle task는 disconnect() 없이 취소된다.
        lifecycle task가 `await shutdown_event.wait()`에서 취소되면 그 이후의
        `disconnect()`는 실행되지 않으므로 client가 disconnect되지 않은 채 반환된다.

        Returns:
            분리된 ClaudeSDKClient (없으면 None)
        """
        client = self.client
        lifecycle_task = self._lifecycle_task

        self.client = None
        self.pid = None
        self._session_id = None
        self._options_fp = None
        self._lifecycle_task = None
        self._shutdown_event = None

        # lifecycle task를 취소하여 orphan task 방지.
        # shutdown_event 없이 취소하므로 disconnect()는 호출되지 않는다.
        if lifecycle_task is not None and not lifecycle_task.done():
            lifecycle_task.cancel()

        return client

    def is_idle(self, is_execution_running: bool) -> bool:
        """client가 연결되어 있고 현재 실행 중이 아닌지 확인한다.

        Args:
            is_execution_running: 호출자(Runner)의 현재 실행 루프 실행 여부

        Returns:
            True이면 풀에서 재사용 가능한 상태
        """
        if self.client is None:
            return False
        if is_execution_running:
            return False
        return True

    def is_cli_alive(self) -> bool:
        """CLI 서브프로세스가 아직 살아있는지 확인."""
        if not isinstance(self.pid, int):
            return False
        try:
            proc = psutil.Process(self.pid)
            return proc.is_running()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False
