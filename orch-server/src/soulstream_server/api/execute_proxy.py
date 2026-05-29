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
from soulstream_server.api.node_utils import find_session_node
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

        # 노드 탐색 (SSE 시작 전이므로 HTTPException 가능)
        node = await find_session_node(session_id, db, node_manager)

        return _create_sse_response(
            node, session_id, node.node_id,
            intervene_prompt=body.prompt,
            intervene_user="",
        )

    def _create_sse_response(
        node,
        session_id: str,
        node_id: str,
        intervene_prompt: str | None = None,
        intervene_user: str = "",
    ) -> EventSourceResponse:
        """SSE 이벤트 스트림을 생성한다.

        Args:
            node: NodeConnection 인스턴스
            session_id: 세션 ID
            node_id: 노드 ID
            intervene_prompt: Resume 모드일 때 intervention 텍스트. None이면 New 모드.
            intervene_user: Resume 모드 intervention 사용자.
        """

        async def event_generator():
            queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=512)

            async def on_event(data: dict) -> None:
                try:
                    queue.put_nowait(data)
                except asyncio.QueueFull:
                    logger.warning(
                        "SSE queue full for session %s, dropping event",
                        session_id,
                    )

            # 구독 (Resume 모드에서는 intervene 전에 구독해야 이벤트 유실 방지)
            subscribe_id = await node.send_subscribe_events(session_id, on_event)

            try:
                # Resume 모드: 구독 후 intervention 전송
                if intervene_prompt is not None:
                    await node.send_intervene(
                        session_id, intervene_prompt, intervene_user
                    )

                # init 이벤트
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
                node.unsubscribe_events(session_id, subscribe_id)

        return EventSourceResponse(event_generator())

    return router
