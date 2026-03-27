"""
Nodes API 라우터 — /api/nodes

노드 목록 조회 및 SSE 스트림.
"""

import asyncio
import json
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from sse_starlette.sse import EventSourceResponse

from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster

logger = logging.getLogger(__name__)


def _detect_portrait_mime(data: bytes) -> str:
    """magic bytes로 portrait 이미지 MIME type 감지."""
    if data[:4] == b"\x89PNG":
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    return "image/png"


# 서버 내부 이벤트 타입 → 클라이언트가 기대하는 SSE 이벤트 이름 매핑
_EVENT_TYPE_MAP: dict[str, str] = {
    "node_registered": "node_connected",
    "node_unregistered": "node_disconnected",
}


def create_nodes_router(
    node_manager: NodeManager,
    broadcaster: SessionBroadcaster,
) -> APIRouter:
    router = APIRouter(prefix="/api/nodes", tags=["nodes"])

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
                "portrait_url": (
                    f"/api/nodes/{node_id}/agents/{agent_id}/portrait"
                    if p.get("portrait_url")
                    else ""
                ),
                "max_turns": p.get("max_turns"),
            }
            for agent_id, p in node.agent_profiles.items()
        ]
        return {"agents": agents}

    @router.get("/{node_id}/agents/{agent_id}/portrait")
    async def proxy_agent_portrait(node_id: str, agent_id: str):
        """에이전트 portrait 이미지 프록시.

        등록 메시지에서 캐시된 데이터가 있으면 우선 반환.
        없으면 해당 노드의 soul-server /api/agents/{agent_id}/portrait를 프록시한다.
        """
        node = node_manager.get_node(node_id)
        if not node:
            raise HTTPException(status_code=404, detail=f"노드를 찾을 수 없습니다: {node_id}")

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
                resp = await client.get(url)
        except httpx.RequestError:
            return Response(status_code=502)

        if resp.status_code != 200:
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
