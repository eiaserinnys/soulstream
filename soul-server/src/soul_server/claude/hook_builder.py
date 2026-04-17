"""훅 빌더 — agent_runner._build_hooks() 로직 분리

ClaudeRunner의 훅 생성 로직을 독립 모듈로 분리한다.
PreToolUse, PreCompact, SubagentStart, SubagentStop, Notification, Stop 훅을 생성하며,
서브에이전트/알림 이벤트는 호출자가 전달한 event_queue에 추가한다.
"""

from __future__ import annotations

import logging
from collections import deque
from typing import Any, Optional

from soul_server.engine.types import (
    EngineEvent,
    NotificationEngineEvent,
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

    - PreToolUse (Agent): run_in_background 플래그 차단
    - PreCompact: 컨텍스트 컴팩션 추적
    - SubagentStart: 서브에이전트 시작 추적
    - SubagentStop: 서브에이전트 종료 추적
    - Notification: CLI 알림을 이벤트 큐에 추가
    - Stop: 세션 종료 사유 로깅

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

    # PreToolUse 훅 — Agent 도구의 run_in_background 차단
    # 백그라운드 에이전트 완료 알림을 처리하는 인프라가 없어, 알림이
    # 다음 사용자 턴에 스며드는 버그를 방지하기 위해 강제로 동기 실행시킨다.
    async def on_pre_tool_use_agent(
        hook_input: dict,
        tool_use_id: Optional[str],
        context: Any,
    ) -> dict:
        tool_input = hook_input.get("tool_input", {})
        if tool_input.get("run_in_background"):
            modified_input = {k: v for k, v in tool_input.items() if k != "run_in_background"}
            logger.info(
                f"[PRE_TOOL_USE] run_in_background 제거: tool_use_id={tool_use_id}"
            )
            return {
                "hookEventName": "PreToolUse",
                "updatedInput": modified_input,
            }
        return {}

    hooks["PreToolUse"] = [
        HookMatcher(matcher="Agent", hooks=[on_pre_tool_use_agent])
    ]

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

        # parent_event_id는 task_executor가 현재 user_message의 event_id(int)로 채운다.
        # tool_use_id는 SDK의 문자열 UUID이며 events.id(INTEGER PK)와 호환되지 않으므로
        # 여기서는 None으로 두고, logger에서만 추적 용도로 남긴다.
        event_queue.append(
            SubagentStartEngineEvent(
                agent_type=agent_type,
                parent_event_id=None,
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

        # parent_event_id는 task_executor가 현재 user_message의 event_id(int)로 채운다.
        # tool_use_id는 SDK의 문자열 UUID이며 events.id(INTEGER PK)와 호환되지 않으므로
        # 여기서는 None으로 두고, logger에서만 추적 용도로 남긴다.
        event_queue.append(
            SubagentStopEngineEvent(
                agent_id=agent_id,
                parent_event_id=None,
            )
        )

        logger.info(f"[SUBAGENT_STOP] agent_id={agent_id}, parent_tool_use_id={tool_use_id}")
        return {}

    hooks["SubagentStop"] = [
        HookMatcher(matcher=None, hooks=[on_subagent_stop_hook])
    ]

    # Notification 훅 — CLI 알림을 이벤트 큐에 추가
    async def on_notification(
        hook_input: dict,
        tool_use_id: Optional[str],
        context: Any,
    ) -> dict:
        title = hook_input.get("title", "")
        message = hook_input.get("message", "")
        notification_type = hook_input.get("notification_type", "")
        logger.info(
            f"[NOTIFICATION] {notification_type}: {title} - {message}"
        )
        event_queue.append(
            NotificationEngineEvent(
                title=title,
                message=message,
                notification_type=notification_type,
            )
        )
        return {}

    hooks["Notification"] = [
        HookMatcher(matcher=None, hooks=[on_notification])
    ]

    # Stop 훅 — 세션 종료 사유 로깅
    async def on_stop(
        hook_input: dict,
        tool_use_id: Optional[str],
        context: Any,
    ) -> dict:
        reason = hook_input.get("reason", "unknown")
        logger.info(f"[STOP] reason={reason}")
        return {}

    hooks["Stop"] = [
        HookMatcher(matcher=None, hooks=[on_stop])
    ]

    return hooks if hooks else None
