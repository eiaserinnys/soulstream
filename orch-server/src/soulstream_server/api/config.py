"""
Config API 프록시 — /api/config/settings, /api/dashboard/config

orchestrator 모드에서 설정창이 동작하도록
첫 번째 연결된 soul-server 노드로 HTTP 프록시한다.
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from soulstream_server.api._proxy_utils import forward_auth_headers
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)

# 노드 미연결 또는 HTTP 실패 시 반환할 기본 구조
# {} 대신 user 필드가 있는 구조를 반환하여 프론트엔드 TypeError 방지
_DEFAULT_DASHBOARD_CONFIG = {"user": {"name": "User", "id": "", "hasPortrait": False}, "agents": []}


def create_config_router(
    node_manager: NodeManager,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api",
        tags=["config"],
        dependencies=dependencies or [],
    )

    def _first_node_url(path: str) -> str | None:
        """첫 번째 연결된 노드의 URL을 반환. 노드 없으면 None."""
        nodes = node_manager.get_connected_nodes()
        if not nodes:
            return None
        node = nodes[0]
        return f"http://{node.host}:{node.port}{path}"

    @router.get("/config/settings")
    async def proxy_config_settings_get(request: Request):
        """soul-server의 GET /api/config/settings 프록시.

        soul-server require_dashboard_auth가 401을 반환하지 않도록
        들어온 요청의 Cookie/Authorization 헤더를 forward한다.
        """
        url = _first_node_url("/api/config/settings")
        if not url:
            return JSONResponse({"categories": []})
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=forward_auth_headers(request))
        except httpx.RequestError as e:
            logger.warning("config/settings 프록시 실패: %s", e)
            return JSONResponse({"categories": []})
        if resp.status_code != 200:
            return Response(
                status_code=resp.status_code,
                content=resp.content,
                media_type="application/json",
            )
        return JSONResponse(resp.json())

    @router.put("/config/settings")
    async def proxy_config_settings_put(request: Request):
        """soul-server의 PUT /api/config/settings 프록시."""
        url = _first_node_url("/api/config/settings")
        if not url:
            raise HTTPException(status_code=503, detail="연결된 노드가 없습니다")
        body = await request.json()
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.put(url, json=body, headers=forward_auth_headers(request))
        except httpx.RequestError as e:
            logger.error("config/settings PUT 프록시 실패: %s", e)
            raise HTTPException(status_code=502, detail=str(e))
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "application/json"),
        )

    @router.get("/dashboard/config")
    async def proxy_dashboard_config(request: Request):
        """soul-server의 GET /api/dashboard/config 프록시.

        현재 soul-server 측 엔드포인트가 unguarded이지만, 향후 인증이
        추가되어도 호환되도록 다른 프록시와 동일하게 헤더를 forward한다
        (design-principles.md §9 일관성·대칭성).
        """
        nodes = node_manager.get_connected_nodes()
        if not nodes:
            return JSONResponse(_DEFAULT_DASHBOARD_CONFIG)
        node = nodes[0]
        url = f"http://{node.host}:{node.port}/api/dashboard/config"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=forward_auth_headers(request))
        except httpx.RequestError as e:
            logger.warning("dashboard/config 프록시 실패: %s", e)
            return JSONResponse(_DEFAULT_DASHBOARD_CONFIG)
        if resp.status_code != 200:
            return Response(
                status_code=resp.status_code,
                content=resp.content,
                media_type="application/json",
            )
        data = resp.json()
        user = data.get("user", {})
        if user.get("hasPortrait"):
            user["portraitUrl"] = f"/api/nodes/{node.node_id}/user/portrait"
            data["user"] = user
        return JSONResponse(data)

    return router
