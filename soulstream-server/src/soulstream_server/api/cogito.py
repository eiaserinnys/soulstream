"""
Cogito API 프록시 라우터 — /cogito

soulstream-server는 cogito 인덱스를 직접 보유하지 않는다.
연결된 모든 soul-server 노드에 검색 요청을 fan-out하고 결과를 병합하여 반환한다.
"""

import logging

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


def create_cogito_router(node_manager: NodeManager) -> APIRouter:
    router = APIRouter(prefix="/cogito", tags=["cogito"])

    @router.get("/search")
    async def search(
        q: str = Query(..., description="검색 쿼리"),
        top_k: int = Query(default=10, ge=1, le=100, description="최대 결과 수"),
        event_types: str | None = Query(default=None, description="콤마 구분 이벤트 타입 필터"),
        search_session_id: bool = Query(default=False, description="session_id ILIKE 검색 포함 여부"),
    ):
        """연결된 모든 soul-server 노드에 검색 요청을 fan-out하고 결과를 병합한다.

        각 노드의 응답 포맷: {"results": [{session_id, event_id, score, preview, event_type}]}
        병합 후 score 내림차순 정렬, top_k 개만 반환한다.
        """
        nodes = node_manager.get_connected_nodes()
        if not nodes:
            return {"results": []}

        all_results: list[dict] = []

        params: dict = {"q": q, "top_k": top_k, "search_session_id": search_session_id}
        if event_types is not None:
            params["event_types"] = event_types

        async with httpx.AsyncClient(timeout=10.0) as client:
            for node in nodes:
                url = f"http://{node.host}:{node.port}/cogito/search"
                try:
                    resp = await client.get(url, params=params)
                    if resp.status_code == 200:
                        data = resp.json()
                        all_results.extend(data.get("results", []))
                    else:
                        logger.warning(
                            "cogito/search: node %s returned %d",
                            node.node_id,
                            resp.status_code,
                        )
                except httpx.RequestError as e:
                    logger.warning("cogito/search: node %s unreachable: %s", node.node_id, e)

        # score 내림차순 정렬 후 top_k 개 반환
        all_results.sort(key=lambda x: x.get("score", 0.0), reverse=True)
        return {"results": all_results[:top_k]}

    return router
