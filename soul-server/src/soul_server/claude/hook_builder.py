"""훅 빌더 — agent_runner._build_hooks() 로직 분리

ClaudeRunner의 훅 생성 로직을 독립 모듈로 분리한다.
PreCompact, SubagentStart, SubagentStop 훅을 생성하며,
서브에이전트 이벤트는 호출자가 전달한 event_queue에 추가한다.
"""

from __future__ import annotations

import logging
from collections import deque
from typing import Any, Optional

from soul_server.engine.types import (
    EngineEvent,
    SubagentStartEngineEvent,
    SubagentStopEngineEvent,
)

try:
    from claude_agent_sdk import HookMatcher, HookContext

    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False

logger = logging.getLogger(__name__)


def build_hooks(
    compact_events: Optional[list],
    event_queue: deque[EngineEvent],
) -> Optional[dict]:
    """모든 훅을 생성한다.

    - PreCompact: 컨텍스트 컴팩션 추적
    - SubagentStart: 서브에이전트 시작 추적
    - SubagentStop: 서브에이전트 종료 추적

    Args:
        compact_events: 컴팩션 이벤트 추적 리스트. None이면 PreCompact 훅 생략.
        event_queue: 서브에이전트 이벤트를 저장할 큐.
            ClaudeRunner._drain_events()가 소비한다.

    Returns:
        hooks dict 또는 None (등록할 훅이 없을 때)

    SubagentStart 훅의 tool_use_id 파라미터는 SDK가 부모 Task 도구의
    tool_use_id를 전달한다. 이를 parent_event_id로 사용하여 대시보드가
    서브에이전트 이벤트를 Task 노드 하위에 배치할 수 있도록 한다.
    """
    hooks: dict = {}

    # PreCompact 훅
    if compact_events is not None:

        async def on_pre_compact(
            hook_input: dict,
            tool_use_id: Optional[str],
            context: Any,
        ) -> dict:
            trigger = hook_input.get("trigger", "auto")
            logger.info(f"PreCompact 훅 트리거: trigger={trigger}")
            compact_events.append(
                {
                    "trigger": trigger,
                    "message": f"컨텍스트 컴팩트 실행됨 (트리거: {trigger})",
                }
            )
            return {}

        hooks["PreCompact"] = [HookMatcher(matcher=None, hooks=[on_pre_compact])]

    # SubagentStart 훅 (항상 등록)
    async def on_subagent_start_hook(
        hook_input: dict,
        tool_use_id: Optional[str],
        context: Any,
    ) -> dict:
        agent_id = hook_input.get("agent_id", "")
        agent_type = hook_input.get("agent_type", "")

        event_queue.append(
            SubagentStartEngineEvent(
                agent_type=agent_type,
                parent_event_id=tool_use_id or "",
                agent_id=agent_id,
            )
        )

        logger.info(
            f"[SUBAGENT_START] agent_id={agent_id}, agent_type={agent_type}, parent_tool_use_id={tool_use_id}"
        )
        return {}

    hooks["SubagentStart"] = [
        HookMatcher(matcher=None, hooks=[on_subagent_start_hook])
    ]

    # SubagentStop 훅 (항상 등록)
    async def on_subagent_stop_hook(
        hook_input: dict,
        tool_use_id: Optional[str],
        context: Any,
    ) -> dict:
        agent_id = hook_input.get("agent_id", "")

        event_queue.append(
            SubagentStopEngineEvent(
                agent_id=agent_id,
                parent_event_id=tool_use_id or "",
            )
        )

        logger.info(f"[SUBAGENT_STOP] agent_id={agent_id}, parent_tool_use_id={tool_use_id}")
        return {}

    hooks["SubagentStop"] = [
        HookMatcher(matcher=None, hooks=[on_subagent_stop_hook])
    ]

    return hooks if hooks else None
