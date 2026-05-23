"""
Config API 프록시 — /api/config/settings, /api/dashboard/config

orchestrator 모드에서 설정창이 동작하도록
local REST dashboard API를 지원하는 연결 노드로 HTTP 프록시한다.
"""

import logging
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from soulstream_server.api._proxy_utils import forward_auth_headers
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)

# 노드 미연결 또는 HTTP 실패 시 반환할 기본 구조
# {} 대신 user 필드가 있는 구조를 반환하여 프론트엔드 TypeError 방지
_DEFAULT_DASHBOARD_CONFIG = {"user": {"name": "User", "id": "", "hasPortrait": False}, "agents": []}
_UNSUPPORTED_PATH_STATUS_CODES = {404, 405}


def create_config_router(
    node_manager: NodeManager,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api",
        tags=["config"],
        dependencies=dependencies or [],
    )

    async def _request_first_supported_node(
        request: Request,
        method: Literal["GET", "PUT"],
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> tuple[httpx.Response, Any] | None:
        """path를 지원하는 첫 노드를 찾아 요청한다.

        TS node처럼 local REST dashboard API가 없는 노드는 404/405를 반환한다.
        이 상태와 연결 실패는 후보 탈락으로 보고 다음 노드를 시도한다.
        """
        nodes = node_manager.get_connected_nodes()
        if not nodes:
            return None

        headers = forward_auth_headers(request)
        async with httpx.AsyncClient(timeout=10.0) as client:
            for node in nodes:
                url = f"http://{node.host}:{node.port}{path}"
                try:
                    if method == "GET":
                        resp = await client.get(url, headers=headers)
                    else:
                        resp = await client.put(url, json=json_body, headers=headers)
                except httpx.RequestError as e:
                    logger.warning(
                        "%s 프록시 연결 실패, 다음 노드 시도: node=%s url=%s error=%s",
                        path,
                        node.node_id,
                        url,
                        e,
                    )
                    continue
                if resp.status_code in _UNSUPPORTED_PATH_STATUS_CODES:
                    logger.info(
                        "%s 미지원 노드 건너뜀: node=%s status=%d",
                        path,
                        node.node_id,
                        resp.status_code,
                    )
                    continue
                return resp, node

        return None

    @router.get("/config/settings")
    async def proxy_config_settings_get(request: Request):
        """soul-server의 GET /api/config/settings 프록시.

        soul-server require_dashboard_auth가 401을 반환하지 않도록
        들어온 요청의 Cookie/Authorization 헤더를 forward한다.
        """
        result = await _request_first_supported_node(request, "GET", "/api/config/settings")
        if not result:
            return JSONResponse({"categories": []})
        resp, _node = result
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
        body = await request.json()
        result = await _request_first_supported_node(
            request,
            "PUT",
            "/api/config/settings",
            json_body=body,
        )
        if not result:
            raise HTTPException(status_code=503, detail="설정을 저장할 수 있는 노드가 없습니다")
        resp, _node = result
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
        result = await _request_first_supported_node(request, "GET", "/api/dashboard/config")
        if not result:
            return JSONResponse(_DEFAULT_DASHBOARD_CONFIG)
        resp, node = result
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
