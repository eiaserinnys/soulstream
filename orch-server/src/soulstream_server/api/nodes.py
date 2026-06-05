"""
Nodes API 라우터 — /api/nodes

노드 목록 조회 및 SSE 스트림.
"""

import asyncio
import base64
import json
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from fastapi.responses import Response
from sse_starlette.sse import EventSourceResponse

from soulstream_server.api._proxy_utils import forward_auth_headers
from soulstream_server.api.deprecated import deprecated_api_response
from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster

logger = logging.getLogger(__name__)


def _detect_portrait_mime(data: bytes) -> str:
    """magic bytes로 portrait 이미지 MIME type 감지."""
    if data[:4] == b"\x89PNG":
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] in (b"GIF8",):
        return "image/gif"
    return "application/octet-stream"


# 서버 내부 이벤트 타입 → 클라이언트가 기대하는 SSE 이벤트 이름 매핑
_EVENT_TYPE_MAP: dict[str, str] = {
    "node_registered": "node_connected",
    "node_unregistered": "node_disconnected",
}


class PlanAgentProfileUpdateRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    profile: dict
    create_if_missing: bool = Field(
        default=False,
        validation_alias=AliasChoices("create_if_missing", "createIfMissing"),
    )
    include_text_diff: bool = Field(
        default=False,
        validation_alias=AliasChoices("include_text_diff", "includeTextDiff"),
    )


class ApplyAgentProfileUpdateRequest(PlanAgentProfileUpdateRequest):
    expected_config_checksum: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "expected_config_checksum",
            "expectedConfigChecksum",
        ),
    )


class RollbackAgentsConfigRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    snapshot_path: str | None = Field(
        default=None,
        validation_alias=AliasChoices("snapshot_path", "snapshotPath"),
    )
    snapshot_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("snapshot_id", "snapshotId"),
    )
    include_text_diff: bool = Field(
        default=False,
        validation_alias=AliasChoices("include_text_diff", "includeTextDiff"),
    )


def create_nodes_router(
    node_manager: NodeManager,
    broadcaster: SessionBroadcaster,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/nodes",
        tags=["nodes"],
        dependencies=dependencies or [],
    )

    @router.get("")
    async def list_nodes() -> dict:
        """연결된 노드 목록."""
        return {"nodes": node_manager.get_nodes()}

    @router.get("/{node_id}/agents")
    async def list_node_agents(node_id: str) -> dict:
        """노드에 등록된 에이전트 프로필 목록.

        portrait_url은 오케스트레이터 프록시 URL로 변환하여 반환.
        soul-server의 /api/agents/{id}/portrait → /api/nodes/{node_id}/agents/{id}/portrait
        """
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"노드를 찾을 수 없습니다: {node_id}")
        agents = [
            {
                "id": agent_id,
                "name": p.get("name"),
                "portraitUrl": (
                    f"/api/nodes/{node_id}/agents/{agent_id}/portrait"
                    if p.get("portrait_url")
                    else ""
                ),
                "max_turns": p.get("max_turns"),
                "backend": p.get("backend", "claude"),
            }
            for agent_id, p in node.agent_profiles.items()
        ]
        return {"agents": agents}

    @router.get("/{node_id}/agents/{agent_id}/portrait")
    async def proxy_agent_portrait(node_id: str, agent_id: str, request: Request):
        """에이전트 portrait 이미지 프록시.

        등록 메시지에서 캐시된 데이터가 있으면 우선 반환.
        없으면 해당 노드의 soul-server /api/agents/{agent_id}/portrait를 프록시한다.

        "자원 없음" 케이스(노드 미연결, HTTP 실패, 원격 404)는 404 대신 204 No Content를
        반환하여 브라우저 콘솔의 빨간 에러 노이즈를 줄인다. 클라이언트(ProfileAvatar)는
        onError + onLoad+naturalWidth 가드로 fallback emoji를 일관되게 표시한다.
        5xx는 운영상 의미가 있으므로 그대로 전파.
        """
        node = node_manager.get_node(node_id)
        if not node:
            return Response(status_code=204)

        # 캐시된 portrait 데이터가 있으면 우선 서빙 (원격 노드 HTTP 불필요)
        cached = node.portrait_cache.get(agent_id)
        if cached:
            media_type = _detect_portrait_mime(cached)
            return Response(
                content=cached,
                media_type=media_type,
                headers={"Cache-Control": "public, max-age=3600"},
            )

        url = f"http://{node.host}:{node.port}/api/agents/{agent_id}/portrait"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=forward_auth_headers(request))
        except (httpx.RequestError, httpx.TimeoutException):
            return Response(status_code=204)

        if resp.status_code != 200:
            if resp.status_code == 404:
                return Response(status_code=204)
            return Response(status_code=resp.status_code)

        return Response(
            content=resp.content,
            media_type=resp.headers.get("content-type", "image/png"),
            headers={"Cache-Control": "public, max-age=3600"},
        )

    @router.post("/{node_id}/agents/config/plan-profile-update")
    async def plan_agent_profile_update(
        node_id: str,
        body: PlanAgentProfileUpdateRequest,
    ) -> dict:
        """대상 노드의 agents.yaml profile 변경 계획을 read-only로 조회한다."""
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        try:
            return await node.send_plan_agent_profile_update(
                body.profile,
                create_if_missing=body.create_if_missing,
                include_text_diff=body.include_text_diff,
            )
        except ConnectionError as err:
            raise HTTPException(status_code=503, detail=str(err)) from err
        except RuntimeError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    @router.post("/{node_id}/agents/config/apply-profile-update")
    async def apply_agent_profile_update(
        node_id: str,
        body: ApplyAgentProfileUpdateRequest,
    ) -> dict:
        """대상 노드의 agents.yaml profile 변경을 실제 적용한다."""
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        try:
            return await node.send_apply_agent_profile_update(
                body.profile,
                create_if_missing=body.create_if_missing,
                include_text_diff=body.include_text_diff,
                expected_config_checksum=body.expected_config_checksum,
            )
        except ConnectionError as err:
            raise HTTPException(status_code=503, detail=str(err)) from err
        except RuntimeError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    @router.get("/{node_id}/agents/config/snapshots")
    async def list_agents_config_snapshots(node_id: str) -> dict:
        """대상 노드의 agents.yaml snapshot 목록을 조회한다."""
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        try:
            return await node.send_list_agents_config_snapshots()
        except ConnectionError as err:
            raise HTTPException(status_code=503, detail=str(err)) from err
        except RuntimeError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    @router.post("/{node_id}/agents/config/rollback")
    async def rollback_agents_config(
        node_id: str,
        body: RollbackAgentsConfigRequest,
    ) -> dict:
        """대상 노드의 agents.yaml을 snapshot path 또는 snapshot id로 rollback한다."""
        if not body.snapshot_path and not body.snapshot_id:
            raise HTTPException(
                status_code=422,
                detail="snapshot_path or snapshot_id is required",
            )
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"Node {node_id} not connected")
        try:
            return await node.send_rollback_agents_config(
                snapshot_path=body.snapshot_path,
                snapshot_id=body.snapshot_id,
                include_text_diff=body.include_text_diff,
            )
        except ConnectionError as err:
            raise HTTPException(status_code=503, detail=str(err)) from err
        except RuntimeError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

    @router.get("/{node_id}/oauth-profiles")
    async def deprecated_node_oauth_profiles(node_id: str):
        """Deprecated profile endpoint kept to explain the replacement path."""
        return deprecated_api_response(
            deprecated_path=f"/api/nodes/{node_id}/oauth-profiles",
            replacement_path=f"/api/nodes/{node_id}/claude-auth/profiles",
            replacement_method="GET",
            message=(
                "Deprecated API path. Refresh the dashboard bundle and use "
                f"GET /api/nodes/{node_id}/claude-auth/profiles."
            ),
        )

    @router.get("/{node_id}/user/portrait")
    async def proxy_user_portrait(node_id: str, request: Request):
        """사용자 portrait 이미지 프록시.

        캐시된 portrait_b64가 있으면 우선 서빙 (원격 노드 HTTP 불필요).
        없으면 해당 노드의 soul-server /api/dashboard/portrait/user를 프록시한다.

        "자원 없음" 케이스(노드 미연결, HTTP 실패, 원격 404)는 204 No Content를
        반환하여 브라우저 콘솔 노이즈를 줄인다. 5xx는 그대로 전파.
        """
        node = node_manager.get_node(node_id)
        if not node:
            return Response(status_code=204)

        # 캐시된 portrait_b64가 있으면 우선 서빙 (원격 노드 HTTP 불필요)
        portrait_b64 = node.user_info.get("portrait_b64")
        if portrait_b64:
            try:
                data = base64.b64decode(portrait_b64)
                media_type = _detect_portrait_mime(data)
                return Response(
                    content=data,
                    media_type=media_type,
                    headers={"Cache-Control": "public, max-age=3600"},
                )
            except Exception:
                logger.warning("user portrait_b64 디코딩 실패 (node=%s)", node_id)

        # HTTP 폴백 (b64 없는 경우 — 구 버전 soul-server 또는 portrait_path 미설정)
        url = f"http://{node.host}:{node.port}/api/dashboard/portrait/user"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=forward_auth_headers(request))
        except (httpx.RequestError, httpx.TimeoutException):
            return Response(status_code=204)

        if resp.status_code != 200:
            if resp.status_code == 404:
                return Response(status_code=204)
            return Response(status_code=resp.status_code)

        return Response(
            content=resp.content,
            media_type=resp.headers.get("content-type", "image/png"),
            headers={"Cache-Control": "public, max-age=3600"},
        )

    @router.get("/stream")
    async def node_stream(request: Request) -> EventSourceResponse:
        """노드 변경 SSE 스트림.

        연결 시 현재 스냅샷을 전송한 뒤 변경 이벤트를 릴레이.

        SSE 이벤트:
        - snapshot: OrchestratorNode[] (배열)
        - node_connected: OrchestratorNode
        - node_disconnected: { nodeId: string }
        - node_updated: OrchestratorNode
        """

        async def event_generator():
            # 초기 스냅샷 — 클라이언트는 OrchestratorNode[] 배열을 기대
            nodes = node_manager.get_nodes()
            yield {
                "event": "snapshot",
                "data": json.dumps(nodes),
            }

            # 변경 이벤트 구독
            queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=256)

            async def on_change(
                event_type: str, node_id: str, data: dict | None
            ) -> None:
                try:
                    queue.put_nowait({
                        "type": event_type,
                        "nodeId": node_id,
                        "data": data,
                    })
                except asyncio.QueueFull:
                    logger.warning(
                        "Node stream queue full, event dropped: %s %s",
                        event_type, node_id,
                    )

            node_manager.add_change_listener(on_change)
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

                    raw_type = event.get("type", "update")
                    sse_event_name = _EVENT_TYPE_MAP.get(raw_type, raw_type)

                    # node_connected / node_updated: 노드 정보 전체를 data에 전송
                    # node_disconnected: { nodeId } 만 전송
                    if sse_event_name == "node_disconnected":
                        payload = {"nodeId": event["nodeId"]}
                    else:
                        payload = event.get("data") or {"nodeId": event["nodeId"]}

                    yield {
                        "event": sse_event_name,
                        "data": json.dumps(payload),
                    }
            finally:
                node_manager.remove_change_listener(on_change)

        return EventSourceResponse(event_generator())

    return router
