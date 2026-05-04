"""
세션 이벤트 SSE 스트림 (/api/sessions/{id}/events).

sessions.py 라우터에서 분리된 SSE 핸들러.
히스토리 리플레이, history_sync, 라이브 릴레이, dedup을 담당한다.
"""

import asyncio
import json
import logging
from typing import Any

from fastapi import HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.node_utils import find_session_node
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


async def create_session_events_response(
    session_id: str,
    request: Request,
    db: PostgresSessionDB,
    node_manager: NodeManager,
) -> EventSourceResponse:
    """SSE 이벤트 스트림.

    1. init 이벤트 전송
    2. Last-Event-ID 의미:
       - after_id == 0 (또는 미전송): 히스토리 skip — baseline은 history_sync로 전달
       - after_id > 0: 그 이후 이벤트만 스트리밍 (재연결 catch-up)
    3. history_sync 이벤트로 baseline 전달
    4. 노드에서 라이브 이벤트 릴레이

    모든 대시보드(브라우저/soul-app/데스크톱)는 messages API로 과거 데이터를 별도 로드하므로
    SSE는 신규 구독 시 히스토리 리플레이 없이 라이브만 흘린다.
    """

    async def event_generator():
        # init 이벤트
        yield {
            "event": "init",
            "data": json.dumps({"agentSessionId": session_id}),
        }

        # Last-Event-ID 또는 ?lastEventId 쿼리 파라미터로 시작점 결정.
        # sse-subscribe.ts는 reconnect 시 query param으로 전달하므로 양쪽 모두 인식한다.
        last_event_id_str = (
            request.headers.get("Last-Event-ID")
            or request.query_params.get("lastEventId")
            or "0"
        )
        try:
            after_id = int(last_event_id_str)
        except ValueError:
            after_id = 0

        # 히스토리 phase에서 yield된 event_id를 라이브 dedup에 사용하기 위해
        # seen_event_ids는 history phase 진입 전에 미리 초기화한다.
        seen_event_ids: set[int] = set()
        last_stored_id = 0

        if after_id == 0:
            # 신규 구독: 히스토리 skip. baseline만 보냄.
            last_stored_id = await db.read_last_event_id(session_id)
        else:
            # 재연결: after_id 이후 이벤트만 stream_events_raw 비동기 cursor로 스트리밍.
            # mid-stream disconnect 감지를 위해 yield 사이에 is_disconnected 체크.
            try:
                async for event_id, event_type, payload_text in db.stream_events_raw(
                    session_id, after_id=after_id,
                ):
                    if await request.is_disconnected():
                        return
                    last_stored_id = max(last_stored_id, event_id)
                    # 라이브 phase에서 history와 race로 같은 id가 들어올 때
                    # 중복 방지를 위해 history phase에서 yield한 id를 등록.
                    seen_event_ids.add(event_id)
                    yield {
                        "event": event_type,
                        "data": payload_text,
                        "id": str(event_id),
                    }
            except Exception as e:
                # 명시적 실패 (design-principles §4): 부분 catch-up을 정상 종료로
                # 위장하면 클라이언트는 누락 구간을 영영 못 읽는다. 스트림을 끊어
                # 클라이언트가 같은 lastEventId로 재연결하게 한다.
                logger.error(
                    "Failed to stream events for %s after_id=%d: %s — closing stream",
                    session_id, after_id, e,
                )
                return

        # 라이브 이벤트 릴레이 노드 탐색.
        # 완료된 세션은 노드에 없을 수 있으며, 히스토리 리플레이만으로 충분하다.
        # _find_node()로 인메모리 → DB → 활성 노드 순으로 폴백하여 찾는다.
        # is_live 판정에 노드 유무가 필요하므로 history_sync보다 먼저 시도한다.
        node = None
        try:
            node = await find_session_node(session_id, db, node_manager)
        except HTTPException:
            # 노드를 못 찾는 완료 세션은 라이브 phase 진입 불가.
            pass

        # history_sync 발행 (항상). 노드 유무에 따라 is_live를 정확히 보고하여,
        # 클라이언트 UI가 라이브 대기 상태를 잘못 표시하는 것을 방지한다.
        # soul-server LLM 분기(is_live=False, status="completed")와 대칭.
        sync_payload = {
            "type": "history_sync",
            "last_event_id": last_stored_id,
            "is_live": node is not None,
        }
        yield {
            "event": "history_sync",
            "data": json.dumps(sync_payload, ensure_ascii=False),
        }

        if node is None:
            # 라이브 진입 불가. 클라이언트는 history_sync(is_live=False)로 종료를 인지.
            return

        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=512)

        async def on_event(data: dict) -> None:
            # _stream_events + _handle_subscribe_events 이중 경로로 인한 중복 방지
            payload = data.get("event") or data.get("payload", {})
            raw_id = (
                data.get("eventId")
                or data.get("id")
                or (payload.get("_event_id") if isinstance(payload, dict) else None)
            )
            if raw_id is not None:
                try:
                    int_id = int(raw_id)
                    if int_id in seen_event_ids:
                        return
                    seen_event_ids.add(int_id)
                except (ValueError, TypeError):
                    pass
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                logger.warning("SSE queue full for session %s, dropping event", session_id)

        subscribe_id = await node.send_subscribe_events(session_id, on_event)
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    # keepalive
                    yield {"comment": "keepalive"}
                    continue

                if data is None:
                    break

                event_payload = data.get("event") or data.get("payload", {})
                if isinstance(event_payload, dict):
                    event_type = event_payload.get("type", "message")
                    event_data = json.dumps(event_payload, ensure_ascii=False)
                else:
                    event_type = "message"
                    event_data = json.dumps(data, ensure_ascii=False)

                event_id = (
                    data.get("eventId")
                    or data.get("id")
                    or (event_payload.get("_event_id") if isinstance(event_payload, dict) else None)
                )
                sse_event: dict[str, Any] = {
                    "event": event_type,
                    "data": event_data,
                }
                if event_id is not None:
                    sse_event["id"] = str(event_id)

                yield sse_event
        finally:
            node.unsubscribe_events(session_id, subscribe_id)

    return EventSourceResponse(event_generator())
