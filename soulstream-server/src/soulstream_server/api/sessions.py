"""
Sessions API 라우터 — /api/sessions

세션 CRUD, SSE 이벤트 스트림, 개입/응답 프록시.
"""

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.nodes.node_connection import NodeConnection
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)


# --- Request/Response Models ---

class CreateSessionRequest(BaseModel):
    prompt: str = ""
    nodeId: Optional[str] = None
    folderId: Optional[str] = None
    profile: Optional[str] = None
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    use_mcp: Optional[bool] = None


class InterveneRequest(BaseModel):
    text: str
    user: str = ""


class RespondRequest(BaseModel):
    request_id: str
    answers: dict


class BatchMoveRequest(BaseModel):
    sessionIds: list[str]
    folderId: Optional[str] = None


class ReadPositionRequest(BaseModel):
    last_read_event_id: int


# --- Router Factory ---

def create_sessions_router(
    db: PostgresSessionDB,
    node_manager: NodeManager,
    session_router: SessionRouter,
    broadcaster: SessionBroadcaster | None = None,
    catalog_service: CatalogService | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/sessions", tags=["sessions"])

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

        # snake_case -> camelCase 변환
        result = []
        for s in sessions:
            profiles = _get_profiles_for_session(s, node_manager)
            result.append(_session_to_response(s, profiles))

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
            result = [_session_to_response(s, _get_profiles_for_session(s, node_manager)) for s in sessions]
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
                    yield {
                        "event": event_type,
                        "data": json.dumps(event),
                    }
            finally:
                broadcaster.remove_client(queue)

        return EventSourceResponse(event_generator())

    @router.post("", status_code=201)
    async def create_session(body: CreateSessionRequest) -> dict:
        """세션 생성. 노드에 라우팅."""
        session_id, node_id = await session_router.route_create_session(
            body.model_dump(exclude_none=True)
        )
        # 폴더 배정
        if body.folderId:
            if catalog_service:
                await catalog_service.move_sessions_to_folder([session_id], body.folderId)
            else:
                await db.assign_session_to_folder(session_id, body.folderId)
        return {"agentSessionId": session_id, "nodeId": node_id}

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
            node = node_manager.find_node_for_session(session_id)
            if not node:
                yield {
                    "event": "error",
                    "data": json.dumps({"message": "Session not found on any node"}),
                }
                return

            queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=512)

            async def on_event(data: dict) -> None:
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

                    event_id = data.get("eventId") or data.get("id")
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

    async def _find_node(session_id: str) -> NodeConnection:
        """인메모리 → DB 폴백으로 세션의 노드를 찾는다.

        NodeManager는 DB를 알지 않으므로(설계 원칙 §1 지식 경계),
        DB 폴백은 이미 db를 보유한 API 핸들러 계층에서 수행한다.
        """
        node = node_manager.find_node_for_session(session_id)
        if not node:
            session_data = await db.get_session(session_id)
            if session_data and session_data.get("node_id"):
                node = node_manager.get_node(session_data["node_id"])
        if not node:
            raise HTTPException(status_code=404, detail="Session not found")
        return node

    @router.post("/{session_id}/intervene")
    async def intervene(session_id: str, body: InterveneRequest) -> dict:
        """개입 메시지 전송."""
        node = await _find_node(session_id)
        try:
            result = await node.send_intervene(session_id, body.text, body.user)
            return result
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
        node = await _find_node(session_id)
        result = await node.send_respond(
            session_id, body.request_id, body.answers
        )
        return result

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
        read_pos = await db.get_read_position(session_id)
        if read_pos and broadcaster:
            await broadcaster.emit_read_position_updated(
                session_id,
                read_pos["last_event_id"],
                read_pos["last_read_event_id"],
            )
        return {"ok": True}

    return router


def _get_profiles_for_session(s: dict, node_manager: NodeManager) -> dict:
    """세션이 속한 노드의 _agent_profiles 반환."""
    node = node_manager.find_node_for_session(s.get("session_id", ""))
    return node._agent_profiles if node else {}


def _session_to_response(s: dict, agent_profiles: Optional[dict] = None) -> dict:
    """DB 세션 레코드를 API 응답 형식으로 변환."""
    created_at = s.get("created_at")
    if hasattr(created_at, "isoformat"):
        created_at = created_at.isoformat()
    updated_at = s.get("updated_at")
    if hasattr(updated_at, "isoformat"):
        updated_at = updated_at.isoformat()

    _profiles = agent_profiles or {}
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
    }
    if s.get("agent_id") and s["agent_id"] in _profiles:
        profile = _profiles[s["agent_id"]]
        result["agentName"] = profile.get("name")
        result["agentPortraitUrl"] = profile.get("portrait_url")
    return result
