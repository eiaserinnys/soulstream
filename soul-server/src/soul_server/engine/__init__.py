"""Soulstream 엔진 인터페이스

외부 실행 엔진(ClaudeRunner 등)과의 계약을 정의합니다.
"""

from soul_server.engine.types import (
    EngineEvent,
    EngineEventType,
    EngineResult,
    ProgressCallback,
    CompactCallback,
    InterventionCallback,
    EventCallback,
)
__all__ = [
    "EngineEvent",
    "EngineEventType",
    "EngineResult",
    "ProgressCallback",
    "CompactCallback",
    "InterventionCallback",
    "EventCallback",
]
