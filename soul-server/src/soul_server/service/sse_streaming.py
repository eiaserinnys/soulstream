"""
SSE streaming core — 라이브 이벤트 generator 정본 (design-principles §3).

소울서버의 세션 SSE 라우트(api/tasks.py execute, session_stream / api/sessions.py
stream_session_events)가 같은 라이브 루프를 중복 보유하던 것을 본 모듈로 통합한다.

호출자(라우트 또는 stream_session_events)는 이벤트 큐를 미리 task_manager에
등록(add_listener)하여 stream_live_events에 주입한다. 큐 사전 등록은
"히스토리 읽기 구간 동안 도착한 라이브 이벤트가 유실되는" race condition을 회피한다.
remove_listener는 본 코어의 finally가 책임진다.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional

logger = logging.getLogger(__name__)


def format_sse_event(event: dict, *, has_id_field: bool = True) -> dict:
    """raw event dict → EventSourceResponse가 기대하는 SSE dict.

    `_event_id`가 있으면 SSE `id` 필드로 분리하고, 나머지는 `data`(JSON)로 직렬화한다.
    `has_id_field=False`면 SSE id 필드를 생략한다 (history_sync 등 baseline 메시지용).
    """
    payload = {k: v for k, v in event.items() if k != "_event_id"}
    sse_event: dict = {
        "event": event.get("type", "unknown"),
        "data": json.dumps(payload, ensure_ascii=False, default=str),
    }
    if has_id_field:
        event_id = event.get("_event_id")
        if event_id is not None:
            sse_event["id"] = str(event_id)
    return sse_event


async def stream_live_events(
    agent_session_id: str,
    task_manager,
    event_queue: asyncio.Queue,
    *,
    dedup_after_id: Optional[int] = None,
    break_on_terminal: bool = False,
    keepalive_interval: float = 30.0,
) -> AsyncGenerator[dict, None]:
    """라이브 SSE 이벤트 generator (코어 라이브 루프).

    호출자 책임:
      - event_queue를 미리 ``task_manager.add_listener(agent_session_id, event_queue)``로
        등록한 뒤 주입한다. 코어는 add_listener를 호출하지 않는다 (race condition 회피).

    동작:
      - dedup_after_id가 주어지면 ``_event_id <= dedup_after_id`` 이벤트는 건너뛴다
        (재연결 catch-up 등 히스토리 중복 차단).
      - break_on_terminal=True이면 ``complete``/``error`` 이벤트를 yield한 뒤 루프를 종료한다
        (execute, session_stream의 단발 응답 패턴).
      - keepalive_interval 초 내에 이벤트가 없으면 ``{"comment": "keepalive"}``를 yield한다.
      - finally에서 ``task_manager.listener_manager.remove_listener(agent_session_id, event_queue)``를 호출한다.

    Yields:
        - 정상 이벤트: ``format_sse_event``가 적용된 SSE dict (``{"event": ..., "data": ..., "id": ...}``)
        - keepalive: ``{"comment": "keepalive"}``
    """
    try:
        while True:
            try:
                event = await asyncio.wait_for(
                    event_queue.get(),
                    timeout=keepalive_interval,
                )
            except asyncio.TimeoutError:
                yield {"comment": "keepalive"}
                continue

            if not isinstance(event, dict):
                # 큐에 dict 이외 객체가 들어올 수 있으면 안전한 fallback.
                # 현재 코드 경로에서는 도달하지 않지만 방어선 유지.
                logger.warning("stream_live_events received non-dict event: %r", event)
                continue

            event_id = event.get("_event_id")
            if (
                dedup_after_id is not None
                and event_id is not None
                and event_id <= dedup_after_id
            ):
                continue

            yield format_sse_event(event)

            if break_on_terminal and event.get("type") in ("complete", "error"):
                break
    finally:
        await task_manager.listener_manager.remove_listener(agent_session_id, event_queue)
