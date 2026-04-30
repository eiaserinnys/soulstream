"""
Sessions API 라우터 — /api/sessions

세션 CRUD, SSE 이벤트 스트림, 개입/응답 프록시.
"""

import asyncio
import json
import logging
from typing import Any, Optional  # Optional: _session_to_response, node_manager 파라미터에 사용

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.websockets import WebSocketDisconnect
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.node_utils import find_session_node
from soulstream_server.models import BatchMoveRequest
from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)


# --- Request/Response Models ---

class CreateSessionRequest(BaseModel):
    # 'profile'과 'agentId' 양쪽을 모두 수용한다.
    # - orch-server 고유 용어: profile (노드 위임 WS 페이로드 키)
    # - soul-server 공용 용어: agentId (동일 값의 다른 이름)
    # 두 서버 API를 대칭으로 유지하여 호출자가 용어를 바꾸지 않아도 동작하게 한다.
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = ""
    nodeId: Optional[str] = None
    folderId: Optional[str] = None
    profile: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("profile", "agentId"),
    )
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    use_mcp: Optional[bool] = None
    system_prompt: Optional[str] = None
    oauth_profile_name: Optional[str] = None
    caller_session_id: Optional[str] = None
    attachmentPaths: Optional[list[str]] = None
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 서버가 HTTP Request에서 조립한다.
    model: Optional[str] = None


class InterveneRequest(BaseModel):
    text: str
    user: str = ""
    attachmentPaths: Optional[list[str]] = None


class RespondRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    request_id: str = Field(alias="requestId")
    answers: dict


class RenameSessionRequest(BaseModel):
    displayName: Optional[str] = None


class ReadPositionRequest(BaseModel):
    last_read_event_id: int


# --- Router Factory ---

def create_sessions_router(
    db: PostgresSessionDB,
    node_manager: NodeManager,
    session_router: SessionRouter,
    broadcaster: SessionBroadcaster | None = None,
    catalog_service: CatalogService | None = None,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/sessions",
        tags=["sessions"],
        dependencies=dependencies or [],
    )

    @router.get("")
    async def list_sessions(
        folderId: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
        cursor: Optional[str] = Query(None),
    ) -> dict:
        """세션 목록 조회. cursor 기반 페이지네이션."""
        offset = 0
        if cursor:
            try:
                offset = int(cursor)
            except ValueError:
                offset = 0

        sessions, total = await db.get_all_sessions(
            offset=offset,
            limit=limit,
            folder_id=folderId,
        )

        # snake_case -> camelCase 변환 (크로스-노드 에이전트 프로필 fallback 포함)
        result = [_session_to_response(s, node_manager=node_manager) for s in sessions]

        next_cursor = None
        if offset + limit < total:
            next_cursor = str(offset + limit)

        return {
            "sessions": result,
            "total": total,
            "cursor": next_cursor,
        }

    @router.get("/stream")
    async def session_stream(request: Request) -> EventSourceResponse:
        """세션 목록 변경 SSE 스트림.

        연결 시 현재 세션 목록을 session_list 이벤트로 전송한 뒤,
        세션 생성/수정/삭제/카탈로그 변경 이벤트를 릴레이.

        SSE 이벤트:
        - session_list: { type, sessions, total }
        - session_created: { type, session }
        - session_updated: { type, agent_session_id, ... }
        - session_deleted: { type, agent_session_id }
        - catalog_updated: { type, catalog }
        """

        async def event_generator():
            # 초기 세션 목록 전송
            sessions, total = await db.get_all_sessions(offset=0, limit=200)
            result = [_session_to_response(s, node_manager=node_manager) for s in sessions]
            yield {
                "event": "session_list",
                "data": json.dumps({
                    "type": "session_list",
                    "sessions": result,
                    "total": total,
                }),
            }

            # broadcaster가 없으면 keepalive만 유지
            if broadcaster is None:
                while True:
                    if await request.is_disconnected():
                        return
                    yield {"comment": "keepalive"}
                    await asyncio.sleep(30)

            # 브로드캐스터 구독 (공개 API 사용)
            queue = broadcaster.add_client()
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=30)
                    except asyncio.TimeoutError:
                        yield {"comment": "keepalive"}
                        continue

                    if event is None:
                        break

                    event_type = event.get("type", "message")
                    # 브로드캐스터는 raw DB 딕셔너리를 그대로 전송한다.
                    # session_created/session_updated 이벤트에는 agentId(DB 컬럼)가 포함되나,
                    # agentName/agentPortraitUrl은 DB에 없으므로 포함되지 않는다.
                    # 클라이언트는 초기 session_list(REST)에서 agentName/agentPortraitUrl을 캐시하고,
                    # 실시간 이벤트에서 agentId로 lookup하는 방식을 사용한다. (의도된 설계)
                    yield {
                        "event": event_type,
                        "data": json.dumps(event),
                    }
            finally:
                broadcaster.remove_client(queue)

        return EventSourceResponse(event_generator())

    @router.post("", status_code=201)
    async def create_session(body: CreateSessionRequest, request: Request) -> dict:
        """세션 생성. 노드에 라우팅."""
        # caller_info 조립: body에 있으면 그대로, 없으면 HTTP Request에서 수집 (source="browser")
        caller_info = body.caller_info or {
            "source": "browser",
            "ip": request.client.host if request.client else None,
            "user_agent": request.headers.get("user-agent"),
            "referer": request.headers.get("referer"),
            "forwarded_for": request.headers.get("x-forwarded-for"),
        }
        payload = body.model_dump(exclude_none=True)
        payload["caller_info"] = caller_info
        session_id, node_id = await session_router.route_create_session(payload)
        # folderId DB 저장은 soul-server create_task에서 처리.
        # soul-stream은 대시보드 폴더 뷰 실시간 반영을 위한 catalog broadcast만 담당.
        # soul-server는 folderId=None인 경우에도 _assign_default_folder_and_broadcast()로
        # 기본 폴더를 배정하므로, folderId 유무와 무관하게 broadcast_catalog()를 호출해야 한다.
        # catalog_service=None(테스트/독립 실행)이면 broadcast할 클라이언트가 없으므로 생략이 의도된 동작.
        if catalog_service:
            await catalog_service.broadcast_catalog()
        return {"agentSessionId": session_id, "nodeId": node_id}

    # === HTTP 프록시 라우트 ===
    # `/{session_id}/events/viewport`는 더 구체적인 경로이므로 `/{session_id}/events`보다
    # **먼저** 등록한다. FastAPI는 정의 순서로 매칭하며, viewport가 뒤에 오면 events가
    # prefix-match로 가로챈다 (soul-server dashboard/routes/sessions.py:181-182의 코멘트와 동일 근거).

    @router.get("/{session_id}/events/viewport")
    async def proxy_session_events_viewport(
        session_id: str,
        y_min: int = Query(..., ge=1),
        y_max: int = Query(..., ge=1),
    ):
        """soul-server `/api/sessions/{id}/events/viewport`로 GET 프록시.

        unified-dashboard(orch-server origin)에서 호출되는 viewport 가상화 API를
        세션의 노드로 forward한다. _find_node가 raise하는 HTTPException(404)은
        FastAPI가 자동 처리하므로 핸들러에서 catch하지 않는다.
        """
        node = await _find_node(session_id)
        url = f"http://{node.host}:{node.port}/api/sessions/{session_id}/events/viewport"
        params = {"y_min": y_min, "y_max": y_max}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params)
        except (httpx.RequestError, httpx.TimeoutException) as e:
            logger.warning("viewport 프록시 실패 (session=%s): %s", session_id, e)
            raise HTTPException(status_code=502, detail=str(e))
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )

    @router.get("/{session_id}/messages")
    async def proxy_session_messages(
        session_id: str,
        before: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
    ):
        """soul-server `/api/sessions/{id}/messages`로 GET 프록시.

        커서 기반 메시지 페이지네이션. before/limit 쿼리 파라미터를 그대로 전달.
        """
        node = await _find_node(session_id)
        url = f"http://{node.host}:{node.port}/api/sessions/{session_id}/messages"
        params: dict[str, object] = {"limit": limit}
        if before is not None:
            params["before"] = before
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, params=params)
        except (httpx.RequestError, httpx.TimeoutException) as e:
            logger.warning("messages 프록시 실패 (session=%s): %s", session_id, e)
            raise HTTPException(status_code=502, detail=str(e))
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )

    @router.get("/{session_id}/events")
    async def session_events(
        session_id: str,
        request: Request,
    ) -> EventSourceResponse:
        """SSE 이벤트 스트림.

        1. init 이벤트 전송
        2. DB에서 히스토리 리플레이 (Last-Event-ID 이후)
        3. 노드에서 라이브 이벤트 릴레이
        """

        async def event_generator():
            # init 이벤트
            yield {
                "event": "init",
                "data": json.dumps({"agentSessionId": session_id}),
            }

            # Last-Event-ID로 히스토리 시작점 결정
            last_event_id_header = request.headers.get("Last-Event-ID", "0")
            try:
                after_id = int(last_event_id_header)
            except ValueError:
                after_id = 0

            # DB 히스토리 리플레이
            events = await db.read_events(session_id, after_id=after_id)
            for evt in events:
                event_type = evt.get("event_type", "message")
                payload = evt.get("payload")
                if isinstance(payload, dict):
                    payload = json.dumps(payload, ensure_ascii=False)
                elif payload is None:
                    payload = "{}"
                yield {
                    "event": event_type,
                    "data": payload,
                    "id": str(evt.get("id", "")),
                }

            # 라이브 이벤트 릴레이
            # 완료된 세션은 노드에 없을 수 있으며, 히스토리 리플레이만으로 충분하다.
            # _find_node()로 인메모리 → DB → 활성 노드 순으로 폴백하여 찾는다.
            try:
                node = await find_session_node(session_id, db, node_manager)
            except HTTPException:
                return

            queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=512)
            seen_event_ids: set[int] = set()

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

    @router.post("/{session_id}/intervene")
    async def intervene(session_id: str, body: InterveneRequest) -> dict:
        """개입 메시지 전송."""
        node = await find_session_node(session_id, db, node_manager)
        try:
            result = await node.send_intervene(
                session_id, body.text, body.user,
                attachment_paths=body.attachmentPaths,
            )
            return result
        except (WebSocketDisconnect, ConnectionError) as e:
            # 노드 WebSocket 연결이 끊어진 경우 → 503 (클라이언트가 재시도 가능)
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            msg = str(e)
            # soul-server SESSION_NOT_FOUND 에러 → 404
            if "찾을 수 없" in msg or "not found" in msg.lower():
                raise HTTPException(status_code=404, detail=msg)
            # 그 외 처리 불가 → 422
            raise HTTPException(status_code=422, detail=msg)

    @router.post("/{session_id}/respond")
    async def respond(session_id: str, body: RespondRequest) -> dict:
        """입력 요청 응답."""
        node = await find_session_node(session_id, db, node_manager)
        result = await node.send_respond(
            session_id, body.request_id, body.answers
        )
        return result

    @router.patch("/{session_id}/display-name")
    async def rename_session(session_id: str, body: RenameSessionRequest) -> dict:
        """세션 표시 이름 변경."""
        if catalog_service:
            await catalog_service.rename_session(session_id, body.displayName)
        else:
            await db.rename_session(session_id, body.displayName)
        return {"success": True}

    @router.patch("/folder")
    async def batch_move_folder(body: BatchMoveRequest) -> dict:
        """세션 일괄 폴더 이동. CatalogService 경유로 cross-tab SSE 동기화."""
        if catalog_service:
            await catalog_service.move_sessions_to_folder(
                body.sessionIds, body.folderId
            )
        else:
            for sid in body.sessionIds:
                await db.assign_session_to_folder(sid, body.folderId)
        return {"success": True, "count": len(body.sessionIds)}

    @router.get("/{session_id}/cards")
    async def session_cards(session_id: str) -> list[dict]:
        """세션의 모든 이벤트를 JSON 배열로 반환."""
        events = await db.read_events(session_id)
        result = []
        for evt in events:
            payload = evt.get("payload")
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except (json.JSONDecodeError, TypeError):
                    pass
            result.append({
                "id": evt.get("id"),
                "type": evt.get("event_type"),
                "payload": payload,
                "createdAt": evt.get("created_at"),
            })
        return result

    @router.put("/{session_id}/read-position")
    async def update_read_position(
        session_id: str, body: ReadPositionRequest
    ) -> dict:
        """읽음 위치 갱신 + SSE 브로드캐스트."""
        await db.update_last_read_event_id(session_id, body.last_read_event_id)
        last_event_id, last_read_event_id = await db.get_read_position(session_id)
        if broadcaster:
            await broadcaster.emit_read_position_updated(
                session_id,
                last_event_id,
                last_read_event_id,
            )
        return {"ok": True}

    return router


def _build_portrait_proxy_url(source_node_id: str, agent_id: str) -> str:
    """에이전트 portrait 프록시 URL을 조립한다. (API 계층 전용)"""
    return f"/api/nodes/{source_node_id}/agents/{agent_id}/portrait"


def _build_user_portrait_proxy_url(node_id: str) -> str:
    """사용자 portrait 프록시 URL을 조립한다. (API 계층 전용)"""
    return f"/api/nodes/{node_id}/user/portrait"


def _session_to_response(
    s: dict,
    node_manager: Optional[NodeManager] = None,
) -> dict:
    """DB 세션 레코드를 API 응답 형식으로 변환.

    node_manager가 제공되면 크로스-노드 에이전트 프로필 fallback을 사용한다.
    원격 노드(eias-linegames 등)의 agent_profiles가 비어있을 때
    다른 연결된 노드에서 같은 에이전트 프로필을 찾는다.
    """
    created_at = s.get("created_at")
    if hasattr(created_at, "isoformat"):
        created_at = created_at.isoformat()
    updated_at = s.get("updated_at")
    if hasattr(updated_at, "isoformat"):
        updated_at = updated_at.isoformat()

    result = {
        "agentSessionId": s.get("session_id"),
        "status": s.get("status"),
        "prompt": s.get("prompt"),
        "createdAt": created_at,
        "updatedAt": updated_at,
        "sessionType": s.get("session_type", "claude"),
        "lastMessage": s.get("last_message"),
        "clientId": s.get("client_id"),
        "metadata": s.get("metadata"),
        "displayName": s.get("display_name"),
        "nodeId": s.get("node_id"),
        "folderId": s.get("folder_id"),
        "lastEventId": s.get("last_event_id", 0),
        "lastReadEventId": s.get("last_read_event_id", 0),
        "agentId": s.get("agent_id"),
        "agentName": None,
        "agentPortraitUrl": None,
        "userName": None,
        "userPortraitUrl": None,
    }

    agent_id = s.get("agent_id")
    node_id = s.get("node_id")
    if agent_id and node_manager is not None:
        found = node_manager.find_agent_profile(agent_id, node_id)
        if found:
            profile, source_node_id = found
            result["agentName"] = profile.get("name")
            if profile.get("portrait_url") and source_node_id:
                result["agentPortraitUrl"] = _build_portrait_proxy_url(
                    source_node_id, agent_id
                )

    if node_id and node_manager is not None:
        user_info = node_manager.get_user_info(node_id)
        if user_info:
            result["userName"] = user_info.get("name")
            if user_info.get("hasPortrait"):
                result["userPortraitUrl"] = _build_user_portrait_proxy_url(node_id)

    return result
