"""
세션 목록 변경 SSE 스트림 (/api/sessions/stream).

sessions.py 라우터에서 분리된 SSE 핸들러.
Last-Event-ID resume, ring buffer replay, dedup을 담당한다.
"""

import asyncio
import json

from fastapi import Request
from sse_starlette.sse import EventSourceResponse

from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.session_serializer import _session_to_response
from soulstream_server.dashboard_access import (
    access_for_request,
    filter_folders,
    filter_session_assignments,
    first_allowed_folder_id,
    is_folder_allowed,
)
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster


async def create_session_stream_response(
    request: Request,
    db: PostgresSessionDB,
    node_manager: NodeManager,
    broadcaster: SessionBroadcaster | None,
    catalog_service=None,
) -> EventSourceResponse:
    """세션 목록 변경 SSE 스트림 (Last-Event-ID resume 지원).

    재연결 클라는 `Last-Event-ID` 헤더 또는 `?lastEventId=N` 쿼리(헤더 우선)로
    마지막 받은 event_id를, `?instanceId={hex}`로 이전 broadcaster instance_id를 알린다.

    응답 흐름:
    1. broadcaster=None: stream_meta 송출 생략 + keepalive (테스트/독립 실행 — 클라가 lastEventIdRef 추적 시작 안 함)
    2. broadcaster 있음:
       - 큐 등록 (replay 호출 전에 등록하여 race 시 dedup으로 차단)
       - stream_meta 첫 yield (instance_id + latest_id, SSE id 미부착)
       - lastEventId 미지정 → initial session_list (REST 풀 스냅샷, SSE id 미부착)
       - lastEventId 지정 + gap=False → replay events (각각 SSE id 필드 포함)
       - lastEventId 지정 + gap=True → replay_gap 이벤트 (latest_id 포함, SSE id 미부착)
       - 큐 구독으로 전환 → broadcast 이벤트 (eid, event) 튜플 unpack 후 SSE id 부착하여 yield
       - replay 중 큐에 쌓인 이벤트는 replay_seen_ids로 dedup

    SSE 이벤트:
    - stream_meta: { type, instance_id, latest_id }  (broadcaster 있을 때만)
    - session_list: { type, sessions, total }  (lastEventId 미지정 시 첫 연결)
    - replay_gap: { type, latest_id, instance_id }  (gap 발생 시 — 클라는 풀 재페치)
    - session_created: { type, session }
    - session_updated: { type, agent_session_id, ... }
    - session_deleted: { type, agent_session_id }
    - catalog_updated: { type, catalog }

    설계 결정:
    - stream_meta·session_list·replay_gap에는 SSE id 미부착. 클라이언트
      lastEventIdRef는 broadcaster가 부여한 id가 있는 이벤트만으로 갱신한다
      (NaN 오염 회피).
    - broadcaster=None은 stream_meta 송출 자체 생략 (sentinel "" 사용 시 진짜 인스턴스와
      구분 안 됨 — design-principles §4 위반).
    - lastEventId is None 분기에서 initial session_list 스냅샷과 큐 사이 race 시
      (스냅샷 직전 broadcast → 큐와 스냅샷 양쪽에 동일 세션) 클라이언트가
      session_created/session_updated를 idempotent(upsert/update 시맨틱)하게
      처리한다는 전제. 중복 도달은 무해.
    """
    last_event_id_str = (
        request.headers.get("last-event-id")
        or request.query_params.get("lastEventId")
    )
    client_instance_id = request.query_params.get("instanceId")
    last_event_id: int | None = None
    if last_event_id_str:
        try:
            last_event_id = int(last_event_id_str)
        except ValueError:
            last_event_id = None

    async def event_generator():
        access = access_for_request(request)

        async def get_folders() -> list[dict]:
            if catalog_service is not None:
                return await catalog_service.list_folders()
            rows = await db.get_all_folders()
            return [
                {
                    "id": row.get("id"),
                    "name": row.get("name"),
                    "sortOrder": row.get("sort_order", row.get("sortOrder", 0)),
                    "parentFolderId": row.get("parent_folder_id", row.get("parentFolderId")),
                    "settings": row.get("settings") or {},
                }
                for row in rows
            ]

        async def filter_event(event: dict) -> dict | None:
            if not access.restricted:
                return event
            event_type = event.get("type")
            folders = await get_folders()
            if event_type == "catalog_updated":
                catalog = event.get("catalog") if isinstance(event.get("catalog"), dict) else {}
                catalog_folders = catalog.get("folders") if isinstance(catalog.get("folders"), list) else folders
                sessions = catalog.get("sessions") if isinstance(catalog.get("sessions"), dict) else {}
                return {
                    **event,
                    "catalog": {
                        **catalog,
                        "folders": filter_folders(access, catalog_folders),
                        "sessions": filter_session_assignments(access, catalog_folders, sessions),
                    },
                }
            if event_type in {"session_created", "session_updated"}:
                session = event.get("session") if isinstance(event.get("session"), dict) else event
                folder_id = (
                    event.get("folder_id")
                    or event.get("folderId")
                    or session.get("folder_id")
                    or session.get("folderId")
                )
                session_id = (
                    event.get("agent_session_id")
                    or event.get("agentSessionId")
                    or session.get("agent_session_id")
                    or session.get("agentSessionId")
                )
                if folder_id is None and isinstance(session_id, str):
                    row = await db.get_session(session_id)
                    if row:
                        folder_id = row.get("folder_id") or row.get("folderId")
                return event if is_folder_allowed(access, folders, folder_id) else None
            if event_type == "session_deleted":
                session_id = event.get("agent_session_id") or event.get("agentSessionId")
                if not isinstance(session_id, str):
                    return None
                row = await db.get_session(session_id)
                if not row:
                    return None
                folder_id = row.get("folder_id") or row.get("folderId")
                return event if is_folder_allowed(access, folders, folder_id) else None
            return event

        # broadcaster=None: stream_meta 송출 생략. 빈 instance_id 송출은
        # "정상 instance와 구분 안 됨"으로 명시적 실패 원칙(design-principles §4) 위반.
        if broadcaster is None:
            while True:
                if await request.is_disconnected():
                    return
                yield {"comment": "keepalive"}
                await asyncio.sleep(30)
            return

        # try 진입 전 None — finally에서 안전 체크 (GeneratorExit 시 누수 차단)
        queue: asyncio.Queue[tuple[int, dict] | None] | None = None
        replay_seen_ids: set[int] = set()
        try:
            # add_client()를 try 안 첫 줄로 — generator close 시 finally로 정리 보장
            queue = broadcaster.add_client()

            # 1. stream_meta (SSE id 미부착)
            yield {
                "event": "stream_meta",
                "data": json.dumps({
                    "type": "stream_meta",
                    "instance_id": broadcaster.instance_id,
                    "latest_id": broadcaster.latest_event_id,
                }),
            }

            if last_event_id is None:
                # 첫 연결: initial session_list (REST 풀 스냅샷, SSE id 미부착)
                folder_id = None
                if access.restricted:
                    folder_id = first_allowed_folder_id(access, await get_folders())
                    if folder_id is None:
                        sessions, total = [], 0
                    else:
                        sessions, total = await db.get_all_sessions(
                            offset=0,
                            limit=200,
                            folder_id=folder_id,
                        )
                else:
                    sessions, total = await db.get_all_sessions(offset=0, limit=200)
                result = [
                    _session_to_response(s, node_manager=node_manager)
                    for s in sessions
                ]
                yield {
                    "event": "session_list",
                    "data": json.dumps({
                        "type": "session_list",
                        "sessions": result,
                        "total": total,
                    }),
                }
            else:
                # 재연결: replay_since로 ring buffer 스캔
                replay = broadcaster.replay_since(last_event_id, client_instance_id)
                if replay.gap:
                    # gap → 클라는 풀 재페치 (SSE id 미부착)
                    yield {
                        "event": "replay_gap",
                        "data": json.dumps({
                            "type": "replay_gap",
                            "latest_id": replay.latest_id,
                            "instance_id": replay.instance_id,
                        }),
                    }
                else:
                    # 누락 이벤트들을 SSE id 부착하여 yield
                    for eid, ev in replay.events:
                        ev = await filter_event(ev)
                        if ev is None:
                            continue
                        ev_type = ev.get("type", "message")
                        yield {
                            "event": ev_type,
                            "id": str(eid),
                            "data": json.dumps(ev),
                        }
                    # replay 중 큐에도 적재된 이벤트는 live 단계에서 skip
                    replay_seen_ids = {eid for eid, _ in replay.events}

            # 2. 큐 구독 루프
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
                    continue

                # disconnect_all sentinel — None 수신 시 종료
                if item is None:
                    break

                eid, event = item
                if eid in replay_seen_ids:
                    # replay에서 이미 yield한 이벤트의 큐 사본 — skip
                    continue

                event_type = event.get("type", "message")
                event = await filter_event(event)
                if event is None:
                    continue
                event_type = event.get("type", "message")
                # 브로드캐스터는 raw DB 딕셔너리를 그대로 전송한다.
                # session_created/session_updated 이벤트에는 agentId(DB 컬럼)가 포함되나,
                # agentName/agentPortraitUrl은 DB에 없으므로 포함되지 않는다.
                # 클라이언트는 초기 session_list(REST)에서 agentName/agentPortraitUrl을 캐시하고,
                # 실시간 이벤트에서 agentId로 lookup하는 방식을 사용한다. (의도된 설계)
                yield {
                    "event": event_type,
                    "id": str(eid),
                    "data": json.dumps(event),
                }
        finally:
            if queue is not None:
                broadcaster.remove_client(queue)

    return EventSourceResponse(event_generator())
