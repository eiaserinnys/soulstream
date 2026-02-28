"""관찰 가능한 Claude SDK 클라이언트

Agent SDK의 ClaudeSDKClient를 서브클래스하여,
SDK가 내부적으로 skip하는 이벤트(rate_limit_event 등)를
raw 스트림 단계에서 가로채어 관찰할 수 있게 한다.

주의: _query는 private 속성이므로 SDK 내부 리팩토링에 취약하다.
"""

import logging
import time
from collections.abc import AsyncIterable
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

try:
    from claude_agent_sdk import ClaudeSDKClient, CLIConnectionError
    from claude_agent_sdk._errors import MessageParseError
    from claude_agent_sdk.types import Message, ResultMessage
    _SDK_AVAILABLE = True
except ImportError:
    _SDK_AVAILABLE = False
    # 더미 클래스
    class ClaudeSDKClient:
        pass
    class CLIConnectionError(Exception):
        pass
    class MessageParseError(Exception):
        pass
    class Message:
        pass
    class ResultMessage:
        pass

logger = logging.getLogger(__name__)

# 콜백 타입
RateLimitCallback = Callable[[dict], None]
UnknownEventCallback = Callable[[str, dict], None]

# Agent SDK가 파싱하는 알려진 메시지 타입
_KNOWN_MESSAGE_TYPES = frozenset({
    "user", "assistant", "system", "result", "stream_event",
})


class InstrumentedClaudeClient(ClaudeSDKClient):
    """rate_limit_event 등 SDK가 skip하는 이벤트를 관찰할 수 있는 확장 클라이언트.

    사용법:
        client = InstrumentedClaudeClient(
            options=options,
            on_rate_limit=my_rate_limit_handler,
            on_unknown_event=my_unknown_handler,
        )
    """

    def __init__(
        self,
        *args,
        on_rate_limit: Optional[RateLimitCallback] = None,
        on_unknown_event: Optional[UnknownEventCallback] = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._on_rate_limit = on_rate_limit
        self._on_unknown_event = on_unknown_event

    async def connect(
        self, prompt: str | AsyncIterable[dict[str, Any]] | None = None
    ) -> None:
        """connect()를 오버라이드하여 옵션, CLI 커맨드, 타이밍을 기록."""
        # Pre-connect 로깅 (실패해도 connect를 막지 않음)
        try:
            opts = self.options
            mcp = getattr(opts, "mcp_servers", None)
            if isinstance(mcp, (Path, str)):
                logger.info(f"[CONNECT] mcp_servers=Path({mcp})")
            elif isinstance(mcp, dict):
                keys = list(mcp.keys()) if mcp else []
                logger.info(f"[CONNECT] mcp_servers=dict(keys={keys})")
            else:
                logger.info(f"[CONNECT] mcp_servers={type(mcp).__name__ if mcp is not None else 'None'}")
            logger.info(
                f"[CONNECT] cwd={getattr(opts, 'cwd', None)}, "
                f"permission_mode={getattr(opts, 'permission_mode', None)}, "
                f"resume={getattr(opts, 'resume', None)}"
            )
        except Exception as e:
            logger.debug(f"[CONNECT] pre-connect logging failed (ignored): {e}")

        t0 = time.monotonic()
        try:
            await super().connect(prompt)
        except Exception as e:
            elapsed = time.monotonic() - t0
            logger.error(f"[CONNECT] connect() FAILED after {elapsed:.2f}s: {e}")
            raise

        elapsed = time.monotonic() - t0
        logger.info(f"[CONNECT] connect() completed in {elapsed:.2f}s")

        # CLI 커맨드 추출 (진단용)
        try:
            transport = self._transport
            if transport and hasattr(transport, "_build_command"):
                cmd = transport._build_command()
                # --mcp-config 값은 길 수 있으므로 요약
                cmd_summary = []
                skip_next = False
                for i, arg in enumerate(cmd):
                    if skip_next:
                        skip_next = False
                        cmd_summary.append(f"<{len(str(arg))}chars>")
                        continue
                    if str(arg) == "--mcp-config" and i + 1 < len(cmd):
                        cmd_summary.append(arg)
                        skip_next = True
                        continue
                    cmd_summary.append(str(arg))
                logger.info(f"[CONNECT] CLI args: {cmd_summary}")
        except Exception as e:
            logger.debug(f"[CONNECT] CLI args 추출 실패 (무시): {e}")

        # initialize 응답 로깅 (MCP 서버, 커맨드 목록 등)
        try:
            server_info = await self.get_server_info()
            if server_info:
                # 키 목록과 주요 정보 요약
                keys = list(server_info.keys())
                logger.info(f"[CONNECT] server_info keys: {keys}")
                # commands가 있으면 이름만 추출
                commands = server_info.get("commands")
                if commands and isinstance(commands, list):
                    cmd_names = [c.get("name", "?") for c in commands if isinstance(c, dict)]
                    logger.info(f"[CONNECT] commands ({len(cmd_names)}): {cmd_names[:20]}{'...' if len(cmd_names) > 20 else ''}")
                # MCP 관련 키가 있으면 출력
                for key in keys:
                    if "mcp" in key.lower() or "tool" in key.lower() or "server" in key.lower():
                        val = server_info[key]
                        logger.info(f"[CONNECT] server_info[{key}]: {str(val)[:500]}")
            else:
                logger.info("[CONNECT] server_info: None")
        except Exception as e:
            logger.debug(f"[CONNECT] server_info 조회 실패 (무시): {e}")

    async def receive_messages(self) -> AsyncIterator[Message]:
        """receive_messages를 오버라이드하여 raw 스트림에서 이벤트를 관찰.

        SDK의 parse_message()가 None을 반환하는 이벤트도
        raw dict 단계에서 콜백으로 전달한다.
        """
        if not self._query:
            raise CLIConnectionError("Not connected. Call connect() first.")

        from claude_agent_sdk._internal.message_parser import parse_message

        async for data in self._query.receive_messages():
            # raw dict 단계에서 관심 이벤트 관찰
            if isinstance(data, dict):
                msg_type = data.get("type")
                if msg_type == "rate_limit_event":
                    self._handle_rate_limit(data)
                elif msg_type and msg_type not in _KNOWN_MESSAGE_TYPES:
                    self._handle_unknown_event(msg_type, data)

            # ⚠️ parse_message()는 unknown type에 MessageParseError를 raise한다.
            # async generator 내부에서 예외가 전파되면 제너레이터가 고갈되어
            # 후속 __anext__() 호출이 StopAsyncIteration을 발생시키므로,
            # 반드시 여기서 catch하여 제너레이터 체인을 보호해야 한다.
            try:
                message = parse_message(data)
            except MessageParseError:
                # rate_limit_event 등 이미 콜백으로 관찰한 이벤트.
                # 제너레이터를 고갈시키지 않고 다음 메시지로 넘어간다.
                continue
            if message is not None:
                yield message

    def _handle_rate_limit(self, data: dict) -> None:
        """rate_limit_event 관찰."""
        if self._on_rate_limit:
            try:
                self._on_rate_limit(data)
            except Exception as e:
                logger.warning(f"rate_limit 콜백 오류: {e}")

    def _handle_unknown_event(self, msg_type: str, data: dict) -> None:
        """unknown event 관찰."""
        if self._on_unknown_event:
            try:
                self._on_unknown_event(msg_type, data)
            except Exception as e:
                logger.warning(f"unknown event 콜백 오류: {e}")
