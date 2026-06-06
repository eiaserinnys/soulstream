"""
Cogito API 프록시 라우터 — /cogito

soulstream-server는 cogito 인덱스를 직접 보유하지 않는다.
연결된 모든 soul-server 노드에 검색 요청을 fan-out하고 결과를 병합하여 반환한다.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from soulstream_server.api._proxy_utils import forward_auth_headers
from soulstream_server.dashboard_access import access_for_request, is_folder_allowed
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)

AGGREGATE_SCHEMA_VERSION = "soulstream.reflect.aggregate.v1"
DEFAULT_BRIEF_TIMEOUT_SECONDS = 5.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _aggregate_source() -> dict:
    return {
        "type": "orchestrator",
        "transport": "node_ws_command",
        "command": "reflect_brief",
    }


def _node_source() -> dict:
    return {
        "type": "node",
        "transport": "websocket",
        "command": "reflect_brief",
    }


def _supports_reflect_brief(node: Any) -> bool:
    capabilities = getattr(node, "capabilities", {}) or {}
    return isinstance(capabilities, dict) and capabilities.get("reflect_brief") is True


async def collect_cogito_briefs(
    node_manager: NodeManager,
    *,
    per_node_timeout: float = DEFAULT_BRIEF_TIMEOUT_SECONDS,
) -> dict:
    """Collect live cogito briefs from connected TS nodes.

    The aggregate is intentionally partial-failure tolerant: a single slow,
    disconnected, or malformed node becomes one typed node entry instead of
    failing the whole response.
    """
    checked_at = _now_iso()
    nodes = [
        node
        for node in node_manager.get_connected_nodes()
        if _supports_reflect_brief(node)
    ]
    if not nodes:
        return {
            "schema_version": AGGREGATE_SCHEMA_VERSION,
            "kind": "orchestrator_node_brief_aggregate",
            "status": "empty",
            "generated_at": checked_at,
            "checked_at": checked_at,
            "source": _aggregate_source(),
            "timeout_seconds": per_node_timeout,
            "node_count": 0,
            "nodes": [],
        }

    entries = await asyncio.gather(
        *(
            _collect_single_node_brief(node, per_node_timeout=per_node_timeout)
            for node in nodes
        )
    )
    status = _aggregate_status(entries)
    return {
        "schema_version": AGGREGATE_SCHEMA_VERSION,
        "kind": "orchestrator_node_brief_aggregate",
        "status": status,
        "generated_at": checked_at,
        "checked_at": checked_at,
        "source": _aggregate_source(),
        "timeout_seconds": per_node_timeout,
        "node_count": len(entries),
        "nodes": entries,
    }


async def _collect_single_node_brief(node: Any, *, per_node_timeout: float) -> dict:
    try:
        result = await node.send_reflect_brief(timeout=per_node_timeout)
    except TimeoutError as err:
        return _error_node_entry(node, "timeout", "node_timeout", err)
    except ConnectionError as err:
        return _error_node_entry(node, "unavailable", "node_unavailable", err)
    except Exception as err:
        return _error_node_entry(node, "error", "node_error", err)

    if not isinstance(result, dict):
        return _error_node_entry(
            node,
            "error",
            "invalid_reflect_brief_response",
            TypeError(f"reflect_brief response must be object, got {type(result).__name__}"),
        )
    brief = result.get("brief")
    if not isinstance(brief, dict):
        return _error_node_entry(
            node,
            "error",
            "invalid_reflect_brief_response",
            TypeError("reflect_brief response missing object field 'brief'"),
        )

    node_checked_at = result.get("checked_at")
    return {
        "node_id": getattr(node, "node_id", ""),
        "status": "ok",
        "checked_at": node_checked_at if isinstance(node_checked_at, str) else _now_iso(),
        "source": _node_source(),
        "data": brief,
        "errors": [],
    }


def _error_node_entry(node: Any, status: str, code: str, err: Exception) -> dict:
    return {
        "node_id": getattr(node, "node_id", ""),
        "status": status,
        "checked_at": _now_iso(),
        "source": _node_source(),
        "data": None,
        "errors": [
            {
                "code": code,
                "message": str(err),
            }
        ],
    }


def _aggregate_status(entries: list[dict]) -> str:
    if not entries:
        return "empty"
    if all(entry.get("status") == "ok" for entry in entries):
        return "ok"
    if any(entry.get("status") == "ok" for entry in entries):
        return "partial"
    return "error"


def create_cogito_router(
    node_manager: NodeManager,
    db: Any | None = None,
    catalog_service: Any | None = None,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/cogito",
        tags=["cogito"],
        dependencies=dependencies or [],
    )

    @router.get("/search")
    async def search(
        request: Request,
        q: str = Query(..., description="검색 쿼리"),
        top_k: int = Query(default=10, ge=1, le=100, description="최대 결과 수"),
        event_types: str | None = Query(default=None, description="콤마 구분 이벤트 타입 필터"),
        search_session_id: bool = Query(default=False, description="session_id ILIKE 검색 포함 여부"),
    ):
        """연결된 모든 soul-server 노드에 검색 요청을 fan-out하고 결과를 병합한다.

        각 노드의 응답 포맷: {"results": [{session_id, event_id, score, preview, event_type}]}
        병합 후 score 내림차순 정렬, top_k 개만 반환한다.

        soul-server 측 cogito 엔드포인트가 현재 unguarded이지만, 향후 인증이
        추가되어도 호환되도록 다른 프록시와 동일하게 헤더를 forward한다.
        """
        nodes = node_manager.get_connected_nodes()
        if not nodes:
            return {"results": []}
        access = access_for_request(request)
        folders: list[dict] = []
        if access.restricted:
            if catalog_service is not None:
                folders = await catalog_service.list_folders()
            elif db is not None:
                rows = await db.get_all_folders()
                folders = [
                    {
                        "id": row.get("id"),
                        "parentFolderId": row.get("parent_folder_id", row.get("parentFolderId")),
                    }
                    for row in rows
                ]

        all_results: list[dict] = []

        params: dict = {"q": q, "top_k": top_k, "search_session_id": search_session_id}
        if event_types is not None:
            params["event_types"] = event_types

        forward_headers = forward_auth_headers(request)
        async with httpx.AsyncClient(timeout=10.0) as client:
            for node in nodes:
                url = f"http://{node.host}:{node.port}/cogito/search"
                try:
                    resp = await client.get(url, params=params, headers=forward_headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        for item in data.get("results", []):
                            if isinstance(item, dict):
                                item.setdefault("node_id", node.node_id)
                                item.setdefault("node_name", node.node_id)
                                all_results.append(item)
                    else:
                        logger.warning(
                            "cogito/search: node %s returned %d",
                            node.node_id,
                            resp.status_code,
                        )
                except httpx.RequestError as e:
                    logger.warning("cogito/search: node %s unreachable: %s", node.node_id, e)

        # score 내림차순 정렬 후 top_k 개 반환
        if access.restricted:
            all_results = await _filter_search_results_by_access(all_results, db, folders, access)
        all_results.sort(key=lambda x: x.get("score", 0.0), reverse=True)
        return {"results": all_results[:top_k]}

    @router.get("/briefs")
    async def briefs(
        timeout: float = Query(
            default=DEFAULT_BRIEF_TIMEOUT_SECONDS,
            gt=0,
            le=30,
            description="Per-node reflect_brief timeout in seconds",
        ),
    ) -> dict:
        """연결된 TS 노드들의 live cogito brief를 WS command 경로로 집계한다."""
        return await collect_cogito_briefs(node_manager, per_node_timeout=timeout)

    return router


async def _filter_search_results_by_access(
    results: list[dict],
    db: Any | None,
    folders: list[dict],
    access: Any,
) -> list[dict]:
    if db is None:
        return []
    allowed: list[dict] = []
    for item in results:
        session_id = item.get("session_id") or item.get("sessionId")
        if not isinstance(session_id, str):
            continue
        row = await db.get_session(session_id)
        if not isinstance(row, dict):
            continue
        folder_id = row.get("folder_id") or row.get("folderId")
        if is_folder_allowed(access, folders, folder_id):
            allowed.append(item)
    return allowed
