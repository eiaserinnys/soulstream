"""
Sessions API 라우터 — /api/sessions

세션 CRUD, SSE 이벤트 스트림, 개입/응답 프록시.
SSE 핸들러는 session_stream.py, session_events.py에 분리되어 있다.

500-line exception: FastAPI route registration stays in one module so endpoint
paths remain auditable; shared policy logic lives in dashboard_access.py.
"""

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Path, Query, Request
from starlette.websockets import WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse

from soul_common.auth.caller_info import resolve_caller_info_or_system
from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

from soulstream_server.api.deprecated import deprecated_api_response
from soulstream_server.api.node_utils import find_session_node
from soulstream_server.api.session_events import create_session_events_response
from soulstream_server.api.session_models import (
    ClaudeRuntimeBackgroundTasksRequest,
    CreateSessionRequest,
    InterveneRequest,
    ReadPositionRequest,
    RealtimeCreateCallRequest,
    RealtimeEventRequest,
    RealtimeToolApprovalRequest,
    RenameSessionRequest,
    RespondRequest,
    SessionCatalogUpdate,
    ToolApprovalRequest,
)
from soulstream_server.api.session_serializer import _session_to_response
from soulstream_server.api.session_stream import create_session_stream_response
from soulstream_server.api.task_scoped_sessions import (
    prepare_task_scoped_session_request,
    task_scoped_response_fields,
)
from soulstream_server.dashboard_access import (
    access_for_request,
    first_allowed_folder_id,
    require_folder_allowed,
    require_session_allowed,
    visible_folder_ids,
)
from soulstream_server.models import BatchMoveRequest
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)

RESPOND_ACK_ERROR_HTTP_STATUS = {
    "SESSION_NOT_FOUND": 404,
    "SESSION_NOT_RUNNING": 409,
    "REQUEST_NOT_PENDING": 422,
    "INPUT_REQUEST_EXPIRED": 422,
    "INPUT_REQUEST_ALREADY_RESPONDED": 422,
    "INPUT_RESPONSE_NOT_SUPPORTED": 422,
}

TOOL_APPROVAL_ACK_ERROR_HTTP_STATUS = {
    "SESSION_NOT_FOUND": 404,
    "SESSION_NOT_RUNNING": 409,
    "TOOL_APPROVAL_NOT_PENDING": 422,
    "TOOL_APPROVAL_ALREADY_RESOLVED": 422,
    "TOOL_APPROVAL_NOT_SUPPORTED": 422,
}


def _field_supplied(model: Any, field_name: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field_name in fields


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
        request: Request,
        folderId: Optional[str] = Query(None),
        folder_id: Optional[str] = Query(None),
        session_type: Optional[str] = Query(None),
        feed_only: bool = Query(False),
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=0, le=200),
        cursor: Optional[str] = Query(None),
    ) -> dict:
        """세션 목록 조회.

        신규 클라이언트는 snake_case `offset`, `limit`, `folder_id`,
        `feed_only`, `session_type`을 사용한다. 기존 dashboard cursor/folderId
        호출은 호환 입력으로 유지한다.
        """
        resolved_offset = offset
        if cursor:
            try:
                resolved_offset = int(cursor)
            except ValueError:
                resolved_offset = 0
        resolved_folder_id = folder_id if folder_id is not None else folderId
        access = access_for_request(request)
        if access.restricted:
            folders = await catalog_service.list_folders() if catalog_service else await db.get_all_folders()
            if resolved_folder_id is None:
                resolved_folder_id = first_allowed_folder_id(access, folders)
                if resolved_folder_id is None:
                    return {
                        "sessions": [],
                        "sessionList": [],
                        "total": 0,
                        "cursor": None,
                        "nextCursor": None,
                        "hasMore": False,
                    }
            require_folder_allowed(access, folders, resolved_folder_id)

        query_kwargs: dict = {"offset": resolved_offset, "limit": limit}
        if session_type is not None:
            query_kwargs["session_type"] = session_type
        if resolved_folder_id is not None:
            query_kwargs["folder_id"] = resolved_folder_id
        if feed_only:
            query_kwargs["feed_only"] = True
        sessions, total = await db.get_all_sessions(**query_kwargs)

        result = [_session_to_response(s, node_manager=node_manager) for s in sessions]

        next_cursor = None
        has_more = False
        if limit > 0:
            loaded_count = resolved_offset + len(result)
            has_more = loaded_count < total
            if has_more:
                next_cursor = str(resolved_offset + limit)

        return {
            "sessions": result,
            "sessionList": result,
            "total": total,
            "cursor": next_cursor,
            "hasMore": has_more,
        }

    @router.get("/folder-counts")
    async def get_folder_counts_endpoint(request: Request) -> dict:
        """폴더별 세션 수 조회."""
        counts = await db.get_folder_counts(node_id=None)
        access = access_for_request(request)
        if access.restricted:
            folders = await catalog_service.list_folders() if catalog_service else await db.get_all_folders()
            allowed_ids = visible_folder_ids(access, folders) or set()
            counts = {
                folder_id: count
                for folder_id, count in counts.items()
                if folder_id in allowed_ids
            }
        return {"counts": {str(k) if k is not None else "null": v for k, v in counts.items()}}

    @router.get("/stream")
    async def session_stream(request: Request) -> EventSourceResponse:
        """세션 목록 변경 SSE 스트림. 구현은 session_stream.py 참조."""
        return await create_session_stream_response(
            request, db, node_manager, broadcaster, catalog_service,
        )

    @router.post("", status_code=201)
    async def create_session(body: CreateSessionRequest, request: Request) -> dict:
        """세션 생성. caller_info 조립은 dispatcher 정본에 위임한다."""
        from soulstream_server.config import get_settings
        settings = get_settings()
        caller_info = resolve_caller_info_or_system(
            body_caller_info=body.caller_info,
            request=request,
            jwt_secret=settings.jwt_secret or "",
            system_node_id=body.nodeId or "",
        )
        task_scope = await prepare_task_scoped_session_request(
            db,
            parent_task_id=body.parentTaskId,
            idempotency_key=body.taskIdempotencyKey,
        )
        if task_scope.existing_response:
            return task_scope.existing_response
        payload = body.model_dump(exclude_none=True)
        access = access_for_request(request)
        if access.restricted:
            folders = await catalog_service.list_folders() if catalog_service else await db.get_all_folders()
            requested_folder_id = payload.get("folderId")
            if requested_folder_id is None:
                requested_folder_id = first_allowed_folder_id(access, folders)
                if requested_folder_id is not None:
                    payload["folderId"] = requested_folder_id
            require_folder_allowed(access, folders, requested_folder_id)
        payload["caller_info"] = caller_info
        if task_scope.extra_context_items:
            payload["extra_context_items"] = task_scope.extra_context_items
        session_id, node_id = await session_router.route_create_session(payload)
        # folderId 저장은 soul-server 담당. orch는 catalog broadcast만 맡는다.
        # folderId가 없어도 soul-server 기본 폴더 배정이 있어 broadcast는 필요하다.
        if catalog_service:
            await catalog_service.broadcast_catalog()
        response = {"agentSessionId": session_id, "nodeId": node_id}
        response.update(await task_scoped_response_fields(
            db,
            parent_task=task_scope.parent_task,
            child_session_id=session_id,
            child_node_id=node_id,
            prompt=body.prompt,
            idempotency_key=body.taskIdempotencyKey,
            logger=logger,
        ))
        return response

    # === DB 직접 조회 라우트 ===
    # messages/viewport는 공유 PostgreSQL 직접 SELECT. viewport는 events보다 먼저 등록한다.

    @router.get("/{session_id}/events/viewport")
    async def get_session_viewport(
        request: Request,
        session_id: str,
        y_min: int = Query(..., ge=1),
        y_max: int = Query(..., ge=1),
    ):
        """세션 이벤트 뷰포트 조회. DB에서 직접 SELECT."""
        await require_session_allowed(request, db, session_id)
        result = await db.read_viewport(session_id, y_min, y_max)
        return result

    @router.get("/{session_id}/messages")
    async def get_session_messages(
        request: Request,
        session_id: str,
        before: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
    ):
        """메시지 페이지네이션 조회. DB에서 직접 SELECT.

        soul-server get_session_messages와 동일 반환 형식.
        """
        await require_session_allowed(request, db, session_id)
        messages, next_cursor = await db.read_messages(
            session_id, before=before, limit=limit,
        )
        return {"messages": messages, "next_cursor": next_cursor}

    @router.get("/{session_id}/timeline")
    async def get_session_timeline(
        request: Request,
        session_id: str,
        before: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
    ):
        """기본 채팅 UI용 semantic timeline 조회. DB에서 직접 SELECT.

        `/messages` raw endpoint는 호환용으로 유지한다.
        """
        await require_session_allowed(request, db, session_id)
        messages, next_cursor = await db.read_timeline(
            session_id, before=before, limit=limit,
        )
        return {"messages": messages, "next_cursor": next_cursor}

    @router.get("/{session_id}/timeline/{timeline_id}/trace")
    async def get_session_timeline_trace(
        request: Request,
        session_id: str,
        timeline_id: str = Path(..., description="timeline_id (예: tool:{tool_use_id})"),
    ):
        """tool summary 상세 trace lazy-load. DB에서 직접 SELECT."""
        await require_session_allowed(request, db, session_id)
        trace = await db.read_timeline_trace(session_id, timeline_id)
        if trace is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": {
                        "code": "TRACE_NOT_FOUND",
                        "message": f"trace를 찾을 수 없습니다: {timeline_id}",
                        "details": {},
                    }
                },
            )
        return trace

    @router.get("/{session_id}/events")
    async def session_events(
        session_id: str,
        request: Request,
    ) -> EventSourceResponse:
        """SSE 이벤트 스트림. 구현은 session_events.py 참조."""
        await require_session_allowed(request, db, session_id)
        return await create_session_events_response(
            session_id, request, db, node_manager,
        )

    @router.post("/{session_id}/intervene")
    async def intervene(
        session_id: str, body: InterveneRequest, request: Request,
    ) -> dict:
        """개입 메시지 전송 (caller_info 운반).

        F-9 fix(2026-05-08): 2차+ 메시지가 첫 메시지와 동일한 발신자 표시를
        받도록 caller_info를 wire 끝까지 운반한다.

        R-6 fix(2026-05-11): caller_info 조립을 `find_session_node` *뒤*로 이동.
        `resolve_caller_info_or_system` dispatcher가 system 분류 시 노드 ID를 요구하는데
        `InterveneRequest`에 `nodeId` 필드가 없어 `find_session_node` 결과 `node.node_id` 사용.
        예외 발생 시 caller_info 조립 미발동 — 기존 동작 정합 (fastapi 자동 처리).
        """
        await require_session_allowed(request, db, session_id)
        from soulstream_server.config import get_settings
        settings = get_settings()
        node = await find_session_node(session_id, db, node_manager)
        caller_info = resolve_caller_info_or_system(
            body_caller_info=body.caller_info,
            request=request,
            jwt_secret=settings.jwt_secret or "",
            system_node_id=node.node_id,
        )
        try:
            result = await node.send_intervene(
                session_id, body.text, body.user,
                attachment_paths=body.attachmentPaths,
                caller_info=caller_info,
                extra_context_items=body.context_items,
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

    @router.post("/{session_id}/message")
    async def deprecated_session_message(session_id: str):
        """Deprecated singular message endpoint for stale desktop bundles."""
        return deprecated_api_response(
            deprecated_path=f"/api/sessions/{session_id}/message",
            replacement_path=f"/api/sessions/{session_id}/intervene",
            replacement_method="POST",
            message=(
                "Deprecated API path. Refresh the dashboard bundle and use "
                f"POST /api/sessions/{session_id}/intervene."
            ),
        )

    @router.post("/{session_id}/interrupt")
    async def interrupt_session(session_id: str, request: Request) -> dict:
        """진행 중인 에이전트 대화를 중단한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            result = await node.send_interrupt_session(session_id)
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            msg = str(e)
            if "not found" in msg.lower() or "찾을 수 없" in msg:
                raise HTTPException(status_code=404, detail=msg)
            if "not running" in msg.lower() or "실행 중" in msg:
                raise HTTPException(status_code=409, detail=msg)
            raise HTTPException(status_code=422, detail=msg)
        return result

    @router.get("/{session_id}/background-tasks")
    async def list_background_tasks(session_id: str, request: Request) -> dict:
        """Claude runtime background task 목록을 조회한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            return await node.send_claude_runtime_list_tasks(session_id)
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            raise _claude_runtime_http_exception(e)

    @router.get("/{session_id}/background-tasks/{task_id}/output")
    async def get_background_task_output(session_id: str, task_id: str, request: Request) -> dict:
        """Claude runtime background task 출력 조회."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            return await node.send_claude_runtime_task_output(session_id, task_id)
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            raise _claude_runtime_http_exception(e)

    @router.post("/{session_id}/background-tasks/{task_id}/stop")
    async def stop_background_task(session_id: str, task_id: str, request: Request) -> dict:
        """Claude runtime background task를 중단한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            return await node.send_claude_runtime_stop_task(session_id, task_id)
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            raise _claude_runtime_http_exception(e)

    @router.post("/{session_id}/background-tasks/background")
    async def background_tasks(
        session_id: str,
        request: Request,
        body: ClaudeRuntimeBackgroundTasksRequest | None = None,
    ) -> dict:
        """Claude SDK Query.backgroundTasks(toolUseId)를 호출한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            return await node.send_claude_runtime_background_tasks(
                session_id,
                body.tool_use_id if body else None,
            )
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            raise _claude_runtime_http_exception(e)

    @router.get("/{session_id}/schedules")
    async def list_schedules(session_id: str, request: Request) -> dict:
        """Soulstream durable schedule 목록을 조회한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            return await node.send_claude_runtime_list_schedules(session_id)
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            raise _claude_runtime_http_exception(e)

    @router.delete("/{session_id}/schedules/{schedule_id}")
    async def delete_schedule(session_id: str, schedule_id: str, request: Request) -> dict:
        """Soulstream durable schedule을 prompt 없이 직접 취소/삭제한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        try:
            result = await node.send_claude_runtime_delete_schedule(
                session_id,
                schedule_id,
            )
            if result.get("status") == "already_firing":
                raise HTTPException(status_code=409, detail=result)
            return result
        except (WebSocketDisconnect, ConnectionError) as e:
            raise HTTPException(
                status_code=503,
                detail=f"Node disconnected, please retry: {e}",
            )
        except RuntimeError as e:
            raise _claude_runtime_http_exception(e)

    @router.post("/{session_id}/respond")
    async def respond(session_id: str, body: RespondRequest, request: Request) -> dict:
        """입력 요청 응답."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        result = await node.send_respond(
            session_id, body.request_id, body.answers
        )
        if result.get("status") == "error":
            _raise_respond_ack_error(result)
        return result

    @router.post("/{session_id}/tool-approvals/{approval_id}/approve")
    async def approve_tool(
        session_id: str,
        approval_id: str,
        request: Request,
        body: ToolApprovalRequest | None = None,
    ) -> dict:
        """OpenAI Agents SDK tool approval 승인."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        req = body or ToolApprovalRequest()
        result = await node.send_tool_approval(
            session_id,
            approval_id,
            "approved",
            message=req.message,
            always_approve=req.alwaysApprove,
        )
        if result.get("status") == "error":
            _raise_tool_approval_ack_error(result)
        return result

    @router.post("/{session_id}/tool-approvals/{approval_id}/reject")
    async def reject_tool(
        session_id: str,
        approval_id: str,
        request: Request,
        body: ToolApprovalRequest | None = None,
    ) -> dict:
        """OpenAI Agents SDK tool approval 거부."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        req = body or ToolApprovalRequest()
        result = await node.send_tool_approval(
            session_id,
            approval_id,
            "rejected",
            message=req.message,
            always_reject=req.alwaysReject,
        )
        if result.get("status") == "error":
            _raise_tool_approval_ack_error(result)
        return result

    @router.post("/{session_id}/realtime/call")
    async def create_realtime_call(
        session_id: str,
        body: RealtimeCreateCallRequest,
        request: Request,
    ) -> dict:
        """soul-app WebRTC SDP offer를 노드 OpenAI Realtime broker로 전달한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        result = await node.send_realtime_create_call(
            session_id,
            body.offerSdp,
            model=body.model,
            voice=body.voice,
            instructions=body.instructions,
        )
        if result.get("status") == "error":
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": result.get("code", "REALTIME_ERROR"), "message": result.get("message", "")}},
            )
        return result

    @router.post("/{session_id}/realtime/events")
    async def relay_realtime_event(
        session_id: str,
        body: RealtimeEventRequest,
        request: Request,
    ) -> dict:
        """soul-app Realtime data-channel event를 세션 SSE/DB로 relay한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        result = await node.send_realtime_event(
            session_id,
            body.event,
            call_id=body.callId,
        )
        if result.get("status") == "error":
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": result.get("code", "REALTIME_ERROR"), "message": result.get("message", "")}},
            )
        return result

    @router.post("/{session_id}/realtime/tool-approvals/{approval_id}/resolve")
    async def resolve_realtime_tool_approval(
        session_id: str,
        approval_id: str,
        body: RealtimeToolApprovalRequest,
        request: Request,
    ) -> dict:
        """Realtime voice 중 발생한 tool approval을 tap/voice 결정으로 resolve한다."""
        await require_session_allowed(request, db, session_id)
        node = await find_session_node(session_id, db, node_manager)
        result = await node.send_realtime_tool_approval(
            session_id,
            approval_id,
            body.decision,
            message=body.message,
            source=body.source,
            call_id=body.callId,
        )
        if result.get("status") == "error":
            raise HTTPException(
                status_code=422,
                detail={"error": {"code": result.get("code", "REALTIME_ERROR"), "message": result.get("message", "")}},
            )
        return result

    @router.patch("/{session_id}/display-name")
    async def rename_session(session_id: str, body: RenameSessionRequest, request: Request) -> dict:
        """세션 표시 이름 변경."""
        await require_session_allowed(request, db, session_id)
        if catalog_service:
            await catalog_service.rename_session(session_id, body.displayName)
        else:
            await db.rename_session(session_id, body.displayName)
        return {"success": True}

    @router.patch("/folder")
    @router.put("/folder")
    async def batch_move_folder(body: BatchMoveRequest, request: Request) -> dict:
        """세션 일괄 폴더 이동. CatalogService 경유로 cross-tab SSE 동기화."""
        access = access_for_request(request)
        if access.restricted:
            folders = await catalog_service.list_folders() if catalog_service else await db.get_all_folders()
            require_folder_allowed(access, folders, body.folderId)
            for session_id in body.sessionIds:
                await require_session_allowed(request, db, session_id)
        if catalog_service:
            await catalog_service.move_sessions_to_folder(
                body.sessionIds, body.folderId
            )
        else:
            for sid in body.sessionIds:
                await db.assign_session_to_folder(sid, body.folderId)
        return {"success": True, "count": len(body.sessionIds)}

    @router.put("/{session_id}")
    async def update_session_catalog(
        session_id: str,
        body: SessionCatalogUpdate,
        request: Request,
    ) -> dict:
        """세션 폴더 이동 + 이름 변경 (개별)."""
        await require_session_allowed(request, db, session_id)
        if _field_supplied(body, "folderId"):
            access = access_for_request(request)
            if access.restricted:
                folders = await catalog_service.list_folders() if catalog_service else await db.get_all_folders()
                require_folder_allowed(access, folders, body.folderId)
            if catalog_service:
                await catalog_service.move_sessions_to_folder([session_id], body.folderId)
            else:
                await db.assign_session_to_folder(session_id, body.folderId)
        if _field_supplied(body, "displayName"):
            if catalog_service:
                await catalog_service.rename_session(session_id, body.displayName)
            else:
                await db.rename_session(session_id, body.displayName)
        return {"ok": True}

    @router.delete("/{session_id}", status_code=204)
    async def delete_session(session_id: str, request: Request):
        """세션 삭제."""
        await require_session_allowed(request, db, session_id)
        if catalog_service:
            await catalog_service.delete_session(session_id)
        else:
            await db.delete_session(session_id)

    @router.get("/{session_id}/cards")
    async def session_cards(session_id: str, request: Request) -> list[dict]:
        """세션의 모든 이벤트를 JSON 배열로 반환."""
        await require_session_allowed(request, db, session_id)
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
        session_id: str, body: ReadPositionRequest, request: Request
    ) -> dict:
        """읽음 위치 갱신 + SSE 브로드캐스트."""
        await require_session_allowed(request, db, session_id)
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


def _raise_respond_ack_error(result: dict[str, Any]) -> None:
    code = str(result.get("code") or "REQUEST_NOT_PENDING")
    message = str(result.get("message") or code)
    status_code = RESPOND_ACK_ERROR_HTTP_STATUS.get(code, 422)
    raise HTTPException(
        status_code=status_code,
        detail={
            "error": {
                "code": code,
                "message": message,
                "inputRequestId": result.get("inputRequestId"),
            },
        },
    )


def _claude_runtime_http_exception(error: RuntimeError) -> HTTPException:
    msg = str(error)
    lower = msg.lower()
    if "not found" in lower or "찾을 수 없" in msg:
        return HTTPException(status_code=404, detail=msg)
    if "not_supported" in lower or "support" in lower:
        return HTTPException(status_code=422, detail=msg)
    return HTTPException(status_code=422, detail=msg)


def _raise_tool_approval_ack_error(result: dict[str, Any]) -> None:
    code = str(result.get("code") or "TOOL_APPROVAL_NOT_PENDING")
    message = str(result.get("message") or code)
    status_code = TOOL_APPROVAL_ACK_ERROR_HTTP_STATUS.get(code, 422)
    raise HTTPException(
        status_code=status_code,
        detail={
            "error": {
                "code": code,
                "message": message,
                "approvalId": result.get("approvalId"),
            },
        },
    )
