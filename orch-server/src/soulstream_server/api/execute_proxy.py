"""
Execute Proxy API 라우터 — POST /api/execute

soul-server의 POST /execute와 동일한 인터페이스를 제공한다.
세션 생성/재개 + SSE 이벤트 스트리밍을 단일 요청-응답으로 통합.
"""

import asyncio
import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from soulstream_server.api.session_models import ClaudePermissionMode
from soulstream_server.api.node_utils import (
    find_session_node,
    http_exception_for_node_resume_runtime_error,
)
from soulstream_server.dashboard_access import (
    access_for_request,
    first_allowed_folder_id,
    require_folder_allowed,
    require_session_allowed,
)
from soulstream_server.service.session_router import SessionRouter

logger = logging.getLogger(__name__)

ReasoningEffort = Literal["minimal", "low", "medium", "high", "xhigh"]


# --- Request Model ---

class ExecuteProxyRequest(BaseModel):
    """soul-server POST /execute 호환 요청 모델."""
    model_config = ConfigDict(populate_by_name=True)

    prompt: str = ""
    agent_session_id: Optional[str] = None
    use_mcp: Optional[bool] = None
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    claude_permission_mode: Optional[ClaudePermissionMode] = Field(
        default=None,
        validation_alias=AliasChoices("claudePermissionMode", "claude_permission_mode"),
    )
    context_items: Optional[list[dict]] = None
    attachment_paths: Optional[list[str]] = Field(
        default=None,
        validation_alias=AliasChoices("attachmentPaths", "attachment_paths"),
    )
    model: Optional[str] = None
    reasoningEffort: Optional[ReasoningEffort] = None
    folder_id: Optional[str] = None
    system_prompt: Optional[str] = None
    profile: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("profile", "agentId"),
    )
    caller_info: Optional[dict] = None
    node_id: Optional[str] = None


def _access_email_from_caller_info(caller_info: dict | None) -> str | None:
    if not isinstance(caller_info, dict):
        return None
    email = caller_info.get("email")
    return email if isinstance(email, str) else None


# --- Router Factory ---

def create_execute_proxy_router(
    db,
    node_manager,
    session_router: SessionRouter,
    catalog_service=None,
    dependencies: list | None = None,
) -> APIRouter:
    """execute-proxy 라우터를 생성한다.

    prefix=/api로 마운트되어 POST /api/execute 경로를 제공한다.
    """
    router = APIRouter(
        prefix="/api",
        tags=["execute"],
        dependencies=dependencies or [],
    )

    @router.post("/execute")
    async def execute_proxy(body: ExecuteProxyRequest, request: Request):
        """soul-server 호환 execute-proxy.

        New 모드 (agent_session_id 없음): 세션 생성 + SSE 스트리밍
        Resume 모드 (agent_session_id 있음): 노드 탐색 + 구독 + intervene + SSE 스트리밍
        """
        if body.agent_session_id:
            return await _handle_resume(body, request)
        else:
            return await _handle_new(body, request)

    async def _handle_new(
        body: ExecuteProxyRequest, request: Request
    ) -> EventSourceResponse:
        """New 모드: 세션 생성 후 SSE 이벤트 스트리밍."""
        if not body.profile:
            raise HTTPException(
                status_code=422,
                detail={
                    "error": {
                        "code": "AGENT_PROFILE_REQUIRED",
                        "message": "New execute requests require profile or agentId",
                        "details": {
                            "hint": "Set SEOSOYOUNG_AGENT_ID or send profile/agentId in the request body",
                        },
                    }
                },
            )

        # body -> request_dict (route_create_session이 camelCase 키 사용)
        request_dict: dict[str, Any] = {
            "prompt": body.prompt,
        }
        if body.node_id is not None:
            request_dict["nodeId"] = body.node_id
        if body.profile is not None:
            request_dict["profile"] = body.profile
        if body.allowed_tools is not None:
            request_dict["allowed_tools"] = body.allowed_tools
        if body.disallowed_tools is not None:
            request_dict["disallowed_tools"] = body.disallowed_tools
        if body.claude_permission_mode is not None:
            request_dict["claude_permission_mode"] = body.claude_permission_mode
        if body.use_mcp is not None:
            request_dict["use_mcp"] = body.use_mcp
        if body.folder_id is not None:
            request_dict["folderId"] = body.folder_id
        if body.system_prompt is not None:
            request_dict["system_prompt"] = body.system_prompt
        if body.model is not None:
            request_dict["model"] = body.model
        if body.reasoningEffort is not None:
            request_dict["reasoningEffort"] = body.reasoningEffort
        if body.caller_info is not None:
            request_dict["caller_info"] = body.caller_info
        else:
            # caller_info 조립: HTTP Request에서 수집
            request_dict["caller_info"] = {
                "source": "execute-proxy",
                "ip": request.client.host if request.client else None,
                "user_agent": request.headers.get("user-agent"),
            }

        # context_items -> extra_context_items 변환
        if body.context_items:
            request_dict["extra_context_items"] = body.context_items

        access = access_for_request(
            request,
            access_email=_access_email_from_caller_info(body.caller_info),
        )
        if access.restricted:
            folders = (
                await catalog_service.list_folders()
                if catalog_service
                else await db.get_all_folders()
            )
            requested_folder_id = request_dict.get("folderId")
            if requested_folder_id is None:
                requested_folder_id = first_allowed_folder_id(access, folders)
                if requested_folder_id is not None:
                    request_dict["folderId"] = requested_folder_id
            require_folder_allowed(access, folders, requested_folder_id)

        # 세션 생성 (SSE 시작 전이므로 HTTPException 가능)
        session_id, node_id = await session_router.route_create_session(request_dict)

        # 대시보드 갱신
        if catalog_service:
            await catalog_service.broadcast_catalog()

        # 노드 획득
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(
                status_code=503,
                detail=f"Node {node_id} disconnected after session creation",
            )

        return _create_sse_response(node, session_id, node_id)

    async def _handle_resume(
        body: ExecuteProxyRequest, request: Request
    ) -> EventSourceResponse:
        """Resume 모드: 기존 세션 재개 + SSE 이벤트 스트리밍."""
        session_id = body.agent_session_id

        await require_session_allowed(
            request,
            db,
            session_id,
            access_email=_access_email_from_caller_info(body.caller_info),
        )

        # 노드 탐색 (SSE 시작 전이므로 HTTPException 가능)
        node = await find_session_node(session_id, db, node_manager)
        event_queue, subscribe_id = await _subscribe_session_events(node, session_id)
        try:
            await node.send_intervene(
                session_id,
                body.prompt,
                "",
                attachment_paths=body.attachment_paths,
                caller_info=body.caller_info,
                extra_context_items=body.context_items,
            )
        except RuntimeError as e:
            node.unsubscribe_events(session_id, subscribe_id)
            raise await http_exception_for_node_resume_runtime_error(
                session_id,
                db,
                e,
            )

        return _create_sse_response(
            node,
            session_id,
            node.node_id,
            event_queue=event_queue,
            subscribe_id=subscribe_id,
        )

    async def _subscribe_session_events(node, session_id: str):
        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=512)

        async def on_event(data: dict) -> None:
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                logger.warning(
                    "SSE queue full for session %s, dropping event",
                    session_id,
                )

        subscribe_id = await node.send_subscribe_events(session_id, on_event)
        return queue, subscribe_id

    def _create_sse_response(
        node,
        session_id: str,
        node_id: str,
        event_queue: asyncio.Queue[dict | None] | None = None,
        subscribe_id: str | None = None,
    ) -> EventSourceResponse:
        """SSE 이벤트 스트림을 생성한다.

        Args:
            node: NodeConnection 인스턴스
            session_id: 세션 ID
            node_id: 노드 ID
            event_queue: 이미 구독한 이벤트 큐. None이면 generator 시작 시 구독.
            subscribe_id: 이미 생성한 구독 ID. None이면 generator 시작 시 구독.
        """

        async def event_generator():
            queue = event_queue
            active_subscribe_id = subscribe_id
            if queue is None or active_subscribe_id is None:
                queue, active_subscribe_id = await _subscribe_session_events(
                    node,
                    session_id,
                )

            try:
                # init event
                yield {
                    "event": "init",
                    "data": json.dumps({
                        "type": "init",
                        "agent_session_id": session_id,
                        "node_id": node_id,
                    }),
                }

                # 이벤트 루프
                while True:
                    try:
                        data = await asyncio.wait_for(queue.get(), timeout=30)
                    except asyncio.TimeoutError:
                        yield {"comment": "keepalive"}
                        continue

                    if data is None:
                        break

                    # 이벤트 payload 추출
                    event_payload = data.get("event") or data.get("payload", {})
                    if isinstance(event_payload, dict):
                        event_type = event_payload.get("type", "message")
                        event_data = json.dumps(event_payload, ensure_ascii=False)
                    else:
                        event_type = "message"
                        event_data = json.dumps(data, ensure_ascii=False)

                    # 이벤트 ID 추출
                    event_id = (
                        data.get("eventId")
                        or data.get("id")
                        or (
                            event_payload.get("_event_id")
                            if isinstance(event_payload, dict)
                            else None
                        )
                    )

                    sse_event: dict[str, Any] = {
                        "event": event_type,
                        "data": event_data,
                    }
                    if event_id is not None:
                        sse_event["id"] = str(event_id)

                    yield sse_event

                    # complete/error 이벤트 후 스트림 종료
                    if event_type in ("complete", "error"):
                        break

            finally:
                node.unsubscribe_events(session_id, active_subscribe_id)

        return EventSourceResponse(event_generator())

    return router
