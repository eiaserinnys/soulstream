"""실행 엔진 Runner 프로토콜

Soulstream이 요구하는 Runner 인터페이스를 정의합니다.
ClaudeRunner 등 구체적 구현체는 이 프로토콜을 만족해야 합니다.
"""

from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Protocol, runtime_checkable

from soul_server.engine.types import (
    EngineEvent,
    EngineResult,
    ProgressCallback,
    CompactCallback,
    EventCallback,
)


@runtime_checkable
class RunnerProtocol(Protocol):
    """실행 엔진 Runner가 구현해야 하는 인터페이스

    engine_adapter.py와 runner_pool.py에서 사용하는 메서드/속성을 정의합니다.
    """

    # === 설정 가능 속성 ===

    debug_send_fn: Optional[Callable[[str], None]]
    allowed_tools: Optional[list[str]]
    disallowed_tools: Optional[list[str]]

    # === 초기화 ===

    def __init__(
        self,
        *,
        thread_ts: str = "",
        working_dir: Optional[Path] = None,
        allowed_tools: Optional[list[str]] = None,
        disallowed_tools: Optional[list[str]] = None,
        mcp_config_path: Optional[Path] = None,
        debug_send_fn: Optional[Callable[[str], None]] = None,
        pooled: bool = False,
    ) -> None: ...

    # === 실행 ===

    async def run(
        self,
        prompt: str,
        session_id: Optional[str] = None,
        on_progress: Optional[ProgressCallback] = None,
        on_compact: Optional[CompactCallback] = None,
        on_intervention: Optional[Callable[[], Awaitable[Optional[str]]]] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_event: Optional[EventCallback] = None,
    ) -> EngineResult: ...

    # === 라이프사이클 ===

    async def _get_or_create_client(self) -> Any: ...

    async def _remove_client(self) -> None: ...

    def _is_cli_alive(self) -> bool: ...
