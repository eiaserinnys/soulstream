"""
Nodes API 라우터 — /api/nodes

노드 목록 조회 및 SSE 스트림.
"""

import asyncio
import json
import logging

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from soulstream_server.nodes.node_manager import NodeManager
from soulstream_server.service.session_broadcaster import SessionBroadcaster

logger = logging.getLogger(__name__)


def create_nodes_router(
    node_manager: NodeManager,
    broadcaster: SessionBroadcaster,
) -> APIRouter:
    router = APIRouter(prefix="/api/nodes", tags=["nodes"])

    @router.get("")
    async def list_nodes() -> dict:
        """연결된 노드 목록."""
        return {"nodes": node_manager.get_nodes()}

    @router.get("/stream")
    async def node_stream(request: Request) -> EventSourceResponse:
        """노드 변경 SSE 스트림.

        연결 시 현재 스냅샷을 전송한 뒤 변경 이벤트를 릴레이.
        """

        async def event_generator():
            # 초기 스냅샷
            nodes = node_manager.get_nodes()
            yield {
                "event": "snapshot",
                "data": json.dumps({"nodes": nodes}),
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
                    pass

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

                    yield {
                        "event": event.get("type", "update"),
                        "data": json.dumps(event),
                    }
            finally:
                node_manager.remove_change_listener(on_change)

        return EventSourceResponse(event_generator())

    return router
