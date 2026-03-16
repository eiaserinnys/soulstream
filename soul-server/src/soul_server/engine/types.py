"""Soulstream 엔진 타입 정의

이벤트 = 노드 = 객체: 각 이벤트 타입이 자기 데이터를 갖고, to_sse()로 변환 방법을 안다.
"""

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

from pydantic import BaseModel


@dataclass
class EngineResult:
    """Claude Code 엔진의 순수 실행 결과

    응용 마커(update_requested, restart_requested, list_run)나
    OM 전용 필드는 포함하지 않습니다.
    """

    success: bool
    output: str
    session_id: Optional[str] = None
    error: Optional[str] = None
    is_error: bool = False
    interrupted: bool = False
    usage: Optional[dict] = None
    collected_messages: list[dict] = field(default_factory=list)


@dataclass
class RoleConfig:
    """역할별 도구 접근 설정

    역할 이름("admin", "viewer")은 포함하지 않습니다.
    호출자가 역할 이름 → RoleConfig 매핑을 담당합니다.
    """

    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    mcp_config_path: Optional[Path] = None


# 엔진 전용 콜백 타입
ProgressCallback = Callable[[str], Coroutine[Any, Any, None]]
CompactCallback = Callable[[str, str], Coroutine[Any, Any, None]]
InterventionCallback = Callable[[], Coroutine[Any, Any, Optional[str]]]


# === EngineEvent 타입 계층 ===


@dataclass
class EngineEvent:
    """엔진 이벤트 기본 클래스. 서브클래스가 to_sse()를 구현한다.

    timestamp: 발행 시각 (Unix epoch, float)
    parent_event_id: 서브에이전트 내부 이벤트일 경우 부모 이벤트 ID
    agent_id: 서브에이전트 관련 이벤트일 경우 에이전트 ID
    """

    timestamp: float = field(default_factory=time.time)
    parent_event_id: Optional[str] = None
    agent_id: Optional[str] = None

    def to_sse(self) -> list[BaseModel]:
        raise NotImplementedError(f"{type(self).__name__}.to_sse()")


@dataclass
class ThinkingEngineEvent(EngineEvent):
    """Extended Thinking 이벤트"""

    thinking: str = ""
    signature: str = ""

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import ThinkingSSEEvent
        return [ThinkingSSEEvent(
            thinking=self.thinking,
            signature=self.signature,
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
        )]


@dataclass
class TextDeltaEngineEvent(EngineEvent):
    """텍스트 블록 이벤트 (text_start → text_delta → text_end 시퀀스 생성)"""

    text: str = ""

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import (
            TextStartSSEEvent,
            TextDeltaSSEEvent,
            TextEndSSEEvent,
        )
        return [
            TextStartSSEEvent(
                parent_event_id=self.parent_event_id,
                timestamp=self.timestamp,
            ),
            TextDeltaSSEEvent(
                text=self.text,
                parent_event_id=self.parent_event_id,
                timestamp=self.timestamp,
            ),
            TextEndSSEEvent(
                parent_event_id=self.parent_event_id,
                timestamp=self.timestamp,
            ),
        ]


@dataclass
class ToolStartEngineEvent(EngineEvent):
    """도구 호출 시작 이벤트"""

    tool_name: str = ""
    tool_input: dict = field(default_factory=dict)
    tool_use_id: Optional[str] = None

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import ToolStartSSEEvent
        return [ToolStartSSEEvent(
            tool_name=self.tool_name,
            tool_input=self.tool_input,
            tool_use_id=self.tool_use_id,
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
        )]


@dataclass
class ToolResultEngineEvent(EngineEvent):
    """도구 결과 이벤트"""

    tool_name: str = ""
    result: Any = ""
    is_error: bool = False
    tool_use_id: Optional[str] = None

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import ToolResultSSEEvent
        return [ToolResultSSEEvent(
            tool_name=self.tool_name,
            result=self.result,
            is_error=self.is_error,
            tool_use_id=self.tool_use_id,
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
        )]


@dataclass
class ResultEngineEvent(EngineEvent):
    """최종 결과 이벤트"""

    success: bool = False
    output: str = ""
    error: Optional[str] = None
    usage: Optional[dict] = None
    total_cost_usd: Optional[float] = None

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import ResultSSEEvent
        return [ResultSSEEvent(
            success=self.success,
            output=self.output,
            error=self.error,
            usage=self.usage,
            total_cost_usd=self.total_cost_usd,
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
        )]


@dataclass
class SubagentStartEngineEvent(EngineEvent):
    """서브에이전트 시작 이벤트"""

    agent_type: str = ""

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import SubagentStartSSEEvent
        return [SubagentStartSSEEvent(
            agent_id=self.agent_id or "",
            agent_type=self.agent_type,
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
        )]


@dataclass
class SubagentStopEngineEvent(EngineEvent):
    """서브에이전트 종료 이벤트"""

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import SubagentStopSSEEvent
        return [SubagentStopSSEEvent(
            agent_id=self.agent_id or "",
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
        )]


@dataclass
class InputRequestEngineEvent(EngineEvent):
    """사용자 입력 요청 이벤트 (AskUserQuestion)

    Claude Code가 AskUserQuestion 도구를 호출할 때 발행됩니다.
    can_use_tool 콜백에서 생성하여 이벤트 큐에 추가합니다.
    """

    request_id: str = ""
    tool_use_id: str = ""
    questions: list = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    timeout_sec: float = 300.0

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import InputRequestSSEEvent, InputRequestQuestion
        return [InputRequestSSEEvent(
            request_id=self.request_id,
            tool_use_id=self.tool_use_id,
            questions=[
                InputRequestQuestion(
                    question=q.get("question", ""),
                    header=q.get("header", ""),
                    options=q.get("options", []),
                    multi_select=q.get("multiSelect", False),
                )
                for q in self.questions
            ],
            parent_event_id=self.parent_event_id,
            timestamp=self.timestamp,
            started_at=self.started_at,
            timeout_sec=self.timeout_sec,
        )]


@dataclass
class InputRequestExpiredEngineEvent(EngineEvent):
    """사용자 입력 요청 만료 이벤트

    AskUserQuestion 타임아웃이 발생할 때 발행됩니다.
    클라이언트는 이 이벤트를 받아 선택 창을 닫습니다.
    """

    request_id: str = ""

    def to_sse(self) -> list[BaseModel]:
        from soul_server.models.schemas import InputRequestExpiredSSEEvent
        return [InputRequestExpiredSSEEvent(
            request_id=self.request_id,
            timestamp=self.timestamp,
        )]


# 이벤트 콜백 타입 alias
# EngineEvent를 받아서 코루틴을 반환하는 비동기 콜백
EventCallback = Callable[[EngineEvent], Coroutine[Any, Any, None]]
