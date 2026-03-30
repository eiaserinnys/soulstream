"""메시지 처리기 — agent_runner._receive_messages() 내 블록 처리 로직 분리

ClaudeRunner._receive_messages()에서 개별 SDK 메시지를 받아
상태를 갱신하고 EngineEvent를 발행하는 책임을 담당한다.

메시지 수신 인프라(intervention polling, async iterator, timeout)는
ClaudeRunner에 남아 있다.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional

from soul_server.engine.types import (
    EventCallback,
    ResultEngineEvent,
    TextDeltaEngineEvent,
    ThinkingEngineEvent,
    ToolResultEngineEvent,
    ToolStartEngineEvent,
)

try:
    from claude_agent_sdk.types import (
        AssistantMessage,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ThinkingBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )

    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False

if TYPE_CHECKING:
    from soul_server.claude.agent_runner import MessageState

logger = logging.getLogger(__name__)


class MessageProcessor:
    """SDK 메시지를 처리하여 상태를 갱신하고 이벤트를 발행한다.

    _receive_messages()의 메시지 수신 루프에서 각 메시지를 전달받아 처리한다.
    메시지 수신 인프라(intervention, async iterator)는 호출자가 관리한다.
    """

    def __init__(
        self,
        msg_state: MessageState,
        on_event: Optional[EventCallback] = None,
        on_progress: Optional[Callable[[str], Awaitable[None]]] = None,
        on_session: Optional[Callable[[str], Awaitable[None]]] = None,
        on_client_session_update: Optional[Callable[[str], None]] = None,
    ):
        self.msg_state = msg_state
        self.on_event = on_event
        self.on_progress = on_progress
        self.on_session = on_session
        self.on_client_session_update = on_client_session_update

    async def process(self, message: Any) -> None:
        """단일 메시지를 처리한다."""
        self.msg_state.msg_count += 1

        if isinstance(message, SystemMessage):
            await self._handle_system_message(message)
        elif isinstance(message, AssistantMessage):
            await self._handle_assistant_message(message)
        elif isinstance(message, UserMessage):
            await self._handle_user_message(message)
        elif isinstance(message, ResultMessage):
            await self._handle_result_message(message)

    async def _handle_system_message(self, message: Any) -> None:
        """SystemMessage 처리 — 세션 ID 추출"""
        if hasattr(message, "session_id"):
            # path b 필터링: TaskStartedMessage(SystemMessage)는 session_id + tool_use_id를 가짐
            # - 메인 세션 시작: tool_use_id = None → on_session 발화
            # - 서브에이전트 시작: tool_use_id = non-None → on_session 발화 안 함
            # SDK 독립적으로 tool_use_id 속성 직접 확인 (임포트 불필요)
            if getattr(message, "tool_use_id", None) is not None:
                logger.debug(f"Subagent task start skipped for on_session: {message.session_id}")
                return

            self.msg_state.session_id = message.session_id
            # 클라이언트의 실제 세션 ID를 갱신 (풀 재사용 시 올바른 세션 매칭용)
            if self.msg_state.session_id and self.on_client_session_update:
                self.on_client_session_update(self.msg_state.session_id)
            logger.info(f"세션 ID: {self.msg_state.session_id}")
            # 세션 ID 조기 통지 콜백
            if self.on_session and self.msg_state.session_id:
                try:
                    await self.on_session(self.msg_state.session_id)
                except Exception as e:
                    logger.warning(f"세션 ID 콜백 오류: {e}")

    async def _handle_assistant_message(self, message: Any) -> None:
        """AssistantMessage 처리 — 블록 순회 및 이벤트 발행"""
        msg_parent = getattr(message, "parent_tool_use_id", None)
        if hasattr(message, "content"):
            for block in message.content:
                await self._process_block(block, msg_parent)

    async def _process_block(self, block: Any, msg_parent: Optional[str]) -> None:
        """단일 블록 처리"""
        if isinstance(block, ThinkingBlock):
            await self._handle_thinking(block, msg_parent)
        elif isinstance(block, TextBlock):
            await self._handle_text(block, msg_parent)
        elif isinstance(block, ToolUseBlock):
            await self._handle_tool_use(block, msg_parent)
        elif isinstance(block, ToolResultBlock):
            await self._handle_tool_result(
                block, msg_parent, source="AssistantMessage"
            )

    async def _handle_thinking(
        self, block: Any, msg_parent: Optional[str]
    ) -> None:
        """ThinkingBlock 처리"""
        thinking_text = getattr(block, "thinking", "")
        signature = getattr(block, "signature", "")

        if thinking_text:
            logger.info(f"[THINKING] {len(thinking_text)} chars")
            thinking_preview = thinking_text[:500]
            if len(thinking_text) > 500:
                thinking_preview += "..."
            self.msg_state.collected_messages.append(
                {
                    "role": "assistant",
                    "content": f"[thinking] {thinking_preview}",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )

            if self.on_event:
                try:
                    await self.on_event(
                        ThinkingEngineEvent(
                            thinking=thinking_text,
                            signature=signature,
                            parent_event_id=msg_parent,
                        )
                    )
                except Exception as e:
                    logger.warning(f"이벤트 콜백 오류 (THINKING): {e}")

    async def _handle_text(
        self, block: Any, msg_parent: Optional[str]
    ) -> None:
        """TextBlock 처리"""
        self.msg_state.current_text = block.text

        self.msg_state.collected_messages.append(
            {
                "role": "assistant",
                "content": block.text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )

        if self.on_progress:
            try:
                display_text = self.msg_state.current_text
                if len(display_text) > 1000:
                    display_text = "...\n" + display_text[-1000:]
                await self.on_progress(display_text)
            except Exception as e:
                logger.warning(f"진행 상황 콜백 오류: {e}")

        if self.on_event:
            try:
                await self.on_event(
                    TextDeltaEngineEvent(
                        text=block.text,
                        parent_event_id=msg_parent,
                    )
                )
            except Exception as e:
                logger.warning(f"이벤트 콜백 오류 (TEXT_DELTA): {e}")

    async def _handle_tool_use(
        self, block: Any, msg_parent: Optional[str]
    ) -> None:
        """ToolUseBlock 처리"""
        tool_input_str = ""
        if block.input:
            tool_input_str = json.dumps(block.input, ensure_ascii=False)
        # tool_use_id → tool_name 매핑 기록
        tool_use_id = getattr(block, "id", None)
        if tool_use_id:
            self.msg_state.tool_use_id_to_name[tool_use_id] = block.name
        logger.info(f"[TOOL_USE] {block.name}: {tool_input_str[:500]}")
        self.msg_state.collected_messages.append(
            {
                "role": "assistant",
                "content": f"[tool_use: {block.name}] {tool_input_str}",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )

        if self.on_event:
            try:
                event_tool_input = block.input or {}
                await self.on_event(
                    ToolStartEngineEvent(
                        tool_name=block.name,
                        tool_input=event_tool_input,
                        tool_use_id=tool_use_id,
                        parent_event_id=msg_parent,
                    )
                )
            except Exception as e:
                logger.warning(f"이벤트 콜백 오류 (TOOL_START): {e}")

    async def _handle_tool_result(
        self,
        block: Any,
        msg_parent: Optional[str],
        source: str = "",
    ) -> None:
        """ToolResultBlock 처리 — 중복 방지 포함

        AssistantMessage와 UserMessage 양쪽에서 호출된다.
        emitted_tool_result_ids로 동일 tool_use_id의 중복 발행을 방지한다.
        """
        tool_use_id = getattr(block, "tool_use_id", None)

        # 중복 방지: 동일 tool_use_id의 결과가 이미 발행되었으면 건너뜀
        if tool_use_id and tool_use_id in self.msg_state.emitted_tool_result_ids:
            return
        if tool_use_id:
            self.msg_state.emitted_tool_result_ids.add(tool_use_id)

        content = ""
        if isinstance(block.content, str):
            content = block.content
        elif block.content:
            try:
                content = json.dumps(block.content, ensure_ascii=False)
            except (TypeError, ValueError):
                content = str(block.content)

        tool_name = (
            self.msg_state.tool_use_id_to_name.get(tool_use_id, "")
            if tool_use_id
            else ""
        )
        is_error = bool(getattr(block, "is_error", False))

        logger.info(f"[TOOL_RESULT:{source}] {tool_name}: {content[:500]}")
        self.msg_state.collected_messages.append(
            {
                "role": "tool",
                "content": content,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        )

        if self.on_event:
            try:
                await self.on_event(
                    ToolResultEngineEvent(
                        tool_name=tool_name,
                        result=content,
                        is_error=is_error,
                        tool_use_id=tool_use_id,
                        parent_event_id=msg_parent,
                    )
                )
            except Exception as e:
                logger.warning(f"이벤트 콜백 오류 (TOOL_RESULT:{source}): {e}")

    async def _handle_user_message(self, message: Any) -> None:
        """UserMessage 처리 — ToolResultBlock 추출

        Claude Code SDK는 도구 실행 결과를 UserMessage.content에
        ToolResultBlock으로 반환한다.
        AssistantMessage.content에 ToolResultBlock이 포함되는 경우도 대비하여
        양쪽 모두 처리하되, emitted_tool_result_ids로 중복 발행을 방지한다.
        """
        msg_parent = getattr(message, "parent_tool_use_id", None)

        if hasattr(message, "content") and isinstance(message.content, list):
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    await self._handle_tool_result(
                        block, msg_parent, source="UserMessage"
                    )

    async def _handle_result_message(self, message: Any) -> None:
        """ResultMessage 처리 — 최종 결과 추출"""
        if hasattr(message, "is_error"):
            self.msg_state.is_error = message.is_error
        if hasattr(message, "result"):
            self.msg_state.result_text = message.result
        if hasattr(message, "session_id") and message.session_id:
            self.msg_state.session_id = message.session_id
        if hasattr(message, "usage") and message.usage:
            self.msg_state.usage = message.usage

        if self.on_event:
            try:
                result_output = (
                    self.msg_state.result_text or self.msg_state.current_text
                )
                await self.on_event(
                    ResultEngineEvent(
                        success=not self.msg_state.is_error,
                        output=result_output,
                        error=result_output if self.msg_state.is_error else None,
                        usage=self.msg_state.usage,
                        parent_event_id=None,  # task_executor가 user_request_id로 채움
                    )
                )
            except Exception as e:
                logger.warning(f"이벤트 콜백 오류 (RESULT): {e}")
