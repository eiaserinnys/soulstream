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


def _parse_event_payload(payload_text: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(payload_text)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _app_server_text_stream_key(payload: dict[str, Any]) -> str | None:
    tool_use_id = payload.get("tool_use_id")
    return tool_use_id if isinstance(tool_use_id, str) and tool_use_id else None


def _is_app_server_live_text_fragment(payload: dict[str, Any]) -> bool:
    return (
        payload.get("_live_only") is True
        and payload.get("type") in {"text_start", "text_delta", "text_end"}
        and _app_server_text_stream_key(payload) is not None
    )


def _is_final_app_server_assistant_message(payload: dict[str, Any]) -> bool:
    return (
        payload.get("type") == "assistant_message"
        and payload.get("_final_for_live_stream") is True
        and _app_server_text_stream_key(payload) is not None
    )


def _filter_finalized_app_server_replay_events(
    events: list[tuple[int, str, str]],
) -> list[tuple[int, str, str]]:
    """Hide raw live fragments when the same replay window has the final text.

    Live app-server text still streams through the node queue. This filter only
    applies to DB catch-up after reconnect, where replaying persisted deltas
    makes an already completed historical bubble appear to type again.
    """
    payloads_by_id: dict[int, dict[str, Any]] = {}
    finalized_streams: set[str] = set()

    for event_id, _event_type, payload_text in events:
        payload = _parse_event_payload(payload_text)
        if payload is None:
            continue
        payloads_by_id[event_id] = payload
        if _is_final_app_server_assistant_message(payload):
            stream_key = _app_server_text_stream_key(payload)
            if stream_key is not None:
                finalized_streams.add(stream_key)

    if not finalized_streams:
        return events

    filtered: list[tuple[int, str, str]] = []
    for event_id, event_type, payload_text in events:
        payload = payloads_by_id.get(event_id)
        if (
            payload is not None
            and _is_app_server_live_text_fragment(payload)
            and _app_server_text_stream_key(payload) in finalized_streams
        ):
            continue
        filtered.append((event_id, event_type, payload_text))
    return filtered


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
        queued_event_ids: set[int] = set()
        last_stored_id = 0

        # 라이브 이벤트 릴레이 노드 탐색 + 구독은 history/baseline 계산 전에 시도한다.
        # baseline 읽기와 subscribe_events 사이의 이벤트 유실을 막기 위함이다.
        node = None
        queue: asyncio.Queue[dict | None] | None = None
        subscribe_id: str | None = None

        def _extract_event_id(data: dict, payload: Any | None = None) -> int | None:
            if payload is None:
                payload = data.get("event") or data.get("payload", {})
            raw_id = (
                data.get("eventId")
                or data.get("id")
                or (payload.get("_event_id") if isinstance(payload, dict) else None)
            )
            if raw_id is None:
                return None
            try:
                return int(raw_id)
            except (ValueError, TypeError):
                return None

        async def on_event(data: dict) -> None:
            # _stream_events + _handle_subscribe_events 이중 경로로 인한 중복 방지.
            # history phase가 같은 id를 나중에 yield할 수 있으므로, 여기서는 live queue
            # 내부 중복만 막고 seen_event_ids 판정은 실제 yield 직전에 수행한다.
            int_id = _extract_event_id(data)
            if int_id is not None:
                if int_id in queued_event_ids:
                    return
                queued_event_ids.add(int_id)
            try:
                assert queue is not None
                queue.put_nowait(data)
            except asyncio.QueueFull:
                logger.warning("SSE queue full for session %s, dropping event", session_id)

        try:
            node = await find_session_node(session_id, db, node_manager)
        except HTTPException:
            # 완료된 세션은 노드에 없을 수 있으며, 히스토리/baseline만으로 충분하다.
            pass

        if node is not None:
            queue = asyncio.Queue(maxsize=512)
            subscribe_id = await node.send_subscribe_events(session_id, on_event)

        async def yield_live_event(data: dict) -> dict[str, Any] | None:
            event_payload = data.get("event") or data.get("payload", {})
            int_id = _extract_event_id(data, event_payload)
            if int_id is not None:
                queued_event_ids.discard(int_id)
                if after_id > 0 and int_id <= after_id:
                    return None
                if int_id in seen_event_ids:
                    return None
                seen_event_ids.add(int_id)

            if isinstance(event_payload, dict):
                event_type = event_payload.get("type", "message")
                event_data = json.dumps(event_payload, ensure_ascii=False)
            else:
                event_type = "message"
                event_data = json.dumps(data, ensure_ascii=False)

            sse_event: dict[str, Any] = {
                "event": event_type,
                "data": event_data,
            }
            if int_id is not None:
                sse_event["id"] = str(int_id)
            return sse_event

        try:
            if after_id == 0:
                # 신규 구독: 히스토리 skip. baseline만 보냄.
                last_stored_id = await db.read_last_event_id(session_id)
            else:
                # 재연결: after_id 이후 이벤트만 stream_events_raw 비동기 cursor로 수집한 뒤
                # 완료된 app-server 텍스트의 raw live 조각은 재생하지 않는다.
                # mid-stream disconnect 감지를 위해 cursor 순회 중에도 is_disconnected 체크.
                try:
                    replay_events: list[tuple[int, str, str]] = []
                    async for event_id, event_type, payload_text in db.stream_events_raw(
                        session_id, after_id=after_id,
                    ):
                        if await request.is_disconnected():
                            return
                        last_stored_id = max(last_stored_id, event_id)
                        # 필터로 숨기는 raw delta도 클라이언트 커서 관점에서는 이미 처리된
                        # 이벤트다. 라이브 queue에 같은 id가 들어와도 중복 송출하지 않는다.
                        seen_event_ids.add(event_id)
                        replay_events.append((event_id, event_type, payload_text))

                    replay_events = _filter_finalized_app_server_replay_events(
                        replay_events,
                    )
                    for event_id, event_type, payload_text in replay_events:
                        if await request.is_disconnected():
                            return
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

            # after_id=0 초기 연결에서 subscribe 직후 baseline을 읽는 동안 들어온 live 이벤트는
            # history_sync보다 먼저 내보낸다. 그렇지 않으면 클라이언트가 history_sync.last_event_id를
            # dedup 기준으로 올린 뒤 해당 live 이벤트를 "이미 받은 이벤트"로 버릴 수 있다.
            if after_id == 0 and queue is not None:
                while True:
                    try:
                        pending = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    if pending is None:
                        break
                    live_event = await yield_live_event(pending)
                    if live_event is not None:
                        yield live_event

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

            if node is None or queue is None or subscribe_id is None:
                # 라이브 진입 불가. 클라이언트는 history_sync(is_live=False)로 종료를 인지.
                return

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

                live_event = await yield_live_event(data)
                if live_event is not None:
                    yield live_event
        finally:
            if node is not None and subscribe_id is not None:
                node.unsubscribe_events(session_id, subscribe_id)

    return EventSourceResponse(event_generator())
