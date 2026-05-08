"""
Sessions API 라우터 — /api/sessions

세션 CRUD, SSE 이벤트 스트림, 개입/응답 프록시.
SSE 핸들러는 session_stream.py, session_events.py에 분리되어 있다.
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.websockets import WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse

from soul_common.auth.caller_info import build_browser_caller_info
from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.node_utils import find_session_node
from soulstream_server.api.session_events import create_session_events_response
from soulstream_server.api.session_models import (
    CreateSessionRequest,
    InterveneRequest,
    ReadPositionRequest,
    RenameSessionRequest,
    RespondRequest,
)
from soulstream_server.api.session_serializer import _session_to_response
from soulstream_server.api.session_stream import create_session_stream_response
from soulstream_server.models import BatchMoveRequest
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)


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
        """세션 목록 변경 SSE 스트림. 구현은 session_stream.py 참조."""
        return await create_session_stream_response(
            request, db, node_manager, broadcaster,
        )

    @router.post("", status_code=201)
    async def create_session(body: CreateSessionRequest, request: Request) -> dict:
        """세션 생성. 노드에 라우팅.

        body.caller_info가 있으면 그대로 사용 (슬랙·RN·위임 케이스).
        없으면 build_browser_caller_info가 HTTP 메타 + cookie JWT(있으면)를
        조립하여 source='browser' caller_info를 반환 (방안 B, 2026-05-07).
        """
        # 정본은 lru_cache된 get_settings — caller_info 조립 시점에 호출 (성능 영향 없음)
        from soulstream_server.config import get_settings
        settings = get_settings()
        caller_info = body.caller_info or build_browser_caller_info(
            request, settings.jwt_secret or ""
        )
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

    # === DB 직접 조회 라우트 ===
    # orch-server와 soul-server가 같은 PostgreSQL을 공유하므로
    # messages/viewport는 노드 통신 없이 DB 직접 SELECT.
    # `/{session_id}/events/viewport`는 `/{session_id}/events`보다 먼저 등록하여
    # FastAPI 경로 매칭 순서를 보장한��.

    @router.get("/{session_id}/events/viewport")
    async def get_session_viewport(
        session_id: str,
        y_min: int = Query(..., ge=1),
        y_max: int = Query(..., ge=1),
    ):
        """세션 이벤트 뷰포트 조회. DB에서 직접 SELECT."""
        result = await db.read_viewport(session_id, y_min, y_max)
        return result

    @router.get("/{session_id}/messages")
    async def get_session_messages(
        session_id: str,
        before: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
    ):
        """메시지 페이지네이션 조회. DB에서 직접 SELECT.

        soul-server get_session_messages와 동일 반환 형식.
        """
        messages, next_cursor = await db.read_messages(
            session_id, before=before, limit=limit,
        )
        return {"messages": messages, "next_cursor": next_cursor}

    @router.get("/{session_id}/events")
    async def session_events(
        session_id: str,
        request: Request,
    ) -> EventSourceResponse:
        """SSE 이벤트 스트림. 구현은 session_events.py 참조."""
        return await create_session_events_response(
            session_id, request, db, node_manager,
        )

    @router.post("/{session_id}/intervene")
    async def intervene(
        session_id: str, body: InterveneRequest, request: Request,
    ) -> dict:
        """개입 메시지 전송 (caller_info 운반).

        F-9 fix(2026-05-08): 2차+ 메시지가 첫 메시지와 동일한 발신자 표시를
        받도록 caller_info를 wire 끝까지 운반한다. body.caller_info가 있으면
        그대로 사용(슬랙·soul-app), 없으면 브라우저 dashboard 흐름으로 간주해
        cookie JWT + HTTP 메타로 자동 조립한다 (create_session과 동일 패턴).
        """
        from soulstream_server.config import get_settings
        settings = get_settings()
        caller_info = body.caller_info or build_browser_caller_info(
            request, settings.jwt_secret or "",
        )
        node = await find_session_node(session_id, db, node_manager)
        try:
            result = await node.send_intervene(
                session_id, body.text, body.user,
                attachment_paths=body.attachmentPaths,
                caller_info=caller_info,
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
