"""
Board and markdown API routes.

The old catalog route mixed folders, session list, board items, and
folder assignment state in one payload. Query responsibilities are now split:
folders live under `/api/folders`, sessions under `/api/sessions`, and board
workspace data under `/api/board-items` and `/api/markdown-documents`.
"""

import logging
from typing import Any, Literal, Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from soulstream_server.api._proxy_utils import forward_auth_headers
from soulstream_server.api.node_utils import find_session_node
from soul_common.catalog.catalog_service import CatalogService
from soul_common.auth.caller_info import decode_dashboard_jwt_user
from soulstream_server.config import get_settings
from soulstream_server.dashboard_access import (
    access_for_request,
    require_folder_allowed,
    visible_folder_ids,
)

logger = logging.getLogger(__name__)


class BoardItemPositionUpdate(BaseModel):
    x: float
    y: float


class BoardContainerTarget(BaseModel):
    kind: Literal["folder", "runbook"]
    id: str = Field(..., min_length=1)


class BoardItemContainerMove(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    container: BoardContainerTarget
    x: Optional[float] = None
    y: Optional[float] = None
    idempotency_key: str = Field(
        ...,
        validation_alias=AliasChoices("idempotencyKey", "idempotency_key"),
    )


class MarkdownDocumentCreate(BaseModel):
    folderId: Optional[str] = None
    container: Optional[dict] = None
    title: str
    body: str = ""
    x: Optional[float] = None
    y: Optional[float] = None


class MarkdownDocumentUpdate(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    expected_version: int = Field(..., alias="expectedVersion")


class RunbookItemStatusMutation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["pending", "review", "completed", "cancelled"]
    expected_version: int = Field(
        ...,
        validation_alias=AliasChoices("expectedVersion", "expected_version"),
    )
    idempotency_key: str = Field(
        ...,
        validation_alias=AliasChoices("idempotencyKey", "idempotency_key"),
    )
    reason: Optional[str] = None


class RunbookStatusMutation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: Literal["open", "completed"]
    expected_version: int = Field(
        ...,
        validation_alias=AliasChoices("expectedVersion", "expected_version"),
    )
    idempotency_key: str = Field(
        ...,
        validation_alias=AliasChoices("idempotencyKey", "idempotency_key"),
    )
    reason: Optional[str] = None


class BoardAssetInit(BaseModel):
    name: str
    mime: str
    size: int


class BoardAssetCommitPart(BaseModel):
    partNumber: int
    etag: str


class BoardAssetCommit(BaseModel):
    x: float
    y: float
    width: Optional[int] = None
    height: Optional[int] = None
    durationSeconds: Optional[float] = None
    parts: list[BoardAssetCommitPart] = []


def _field_supplied(model: BaseModel, field_name: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field_name in fields


def _dashboard_user_id_for_request(request: Request) -> str | None:
    auth_user = getattr(request.state, "auth_user", None)
    if not isinstance(auth_user, dict):
        auth_user = decode_dashboard_jwt_user(request, get_settings().jwt_secret or "")
    if not isinstance(auth_user, dict):
        return None
    user_id = auth_user.get("email") or auth_user.get("sub")
    return user_id if isinstance(user_id, str) and user_id else None


def _filter_runbook_overview_for_access(
    overview: dict,
    allowed_folder_ids: set[str] | None,
) -> dict:
    if allowed_folder_ids is None:
        return overview

    def allowed(entry: dict) -> bool:
        folder_id = entry.get("folder_id")
        return isinstance(folder_id, str) and folder_id in allowed_folder_ids

    return {
        "my_turn_items": [
            item for item in overview.get("my_turn_items", [])
            if isinstance(item, dict) and allowed(item)
        ],
        "runbooks": [
            {
                **group,
                "items": [
                    item for item in group.get("items", [])
                    if isinstance(item, dict) and allowed(item)
                ],
            }
            for group in overview.get("runbooks", [])
            if isinstance(group, dict) and allowed(group)
        ],
    }


def _board_asset_error(exc: Exception) -> HTTPException:
    if isinstance(exc, RuntimeError):
        return HTTPException(status_code=503, detail=str(exc))
    detail = str(exc)
    if "size" in detail or "quota" in detail:
        return HTTPException(status_code=413, detail=detail)
    return HTTPException(status_code=400, detail=detail)


async def _resolve_board_container_folder_id(
    catalog_service: CatalogService,
    container_kind: Literal["folder", "runbook"],
    container_id: str,
) -> str:
    if container_kind == "folder":
        return container_id
    catalog = await catalog_service.get_catalog()
    board_items = catalog.get("boardItems") if isinstance(catalog.get("boardItems"), list) else []
    for item in board_items:
        if not isinstance(item, dict):
            continue
        if item.get("itemType") == "runbook" and item.get("itemId") == container_id:
            folder_id = item.get("folderId")
            if isinstance(folder_id, str) and folder_id:
                return folder_id
    raise HTTPException(status_code=404, detail="Runbook board container not found")


async def _resolve_body_board_container(
    catalog_service: CatalogService,
    folder_id: Optional[str],
    container: Optional[dict],
) -> tuple[str, Literal["folder", "runbook"], str]:
    if container is None:
        if not folder_id:
            raise HTTPException(status_code=400, detail="folderId or container is required")
        return folder_id, "folder", folder_id
    kind = container.get("kind")
    container_id = container.get("id")
    if kind not in ("folder", "runbook") or not isinstance(container_id, str) or not container_id:
        raise HTTPException(status_code=400, detail="invalid board container")
    resolved_folder_id = folder_id or await _resolve_board_container_folder_id(
        catalog_service,
        kind,
        container_id,
    )
    return resolved_folder_id, kind, container_id


def create_catalog_router(
    catalog_service: CatalogService,
    db: object | None = None,
    node_manager: object | None = None,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api",
        tags=["board"],
        dependencies=dependencies or [],
    )

    def _resolve_board_yjs_host_node():
        if node_manager is None:
            raise HTTPException(status_code=503, detail="Board Yjs host routing is not configured")
        hosts = [
            node
            for node in node_manager.get_connected_nodes()
            if isinstance(getattr(node, "capabilities", None), dict)
            and node.capabilities.get("board_yjs_host") is True
        ]
        if not hosts:
            raise HTTPException(status_code=503, detail="Board Yjs host node is not connected")
        if len(hosts) > 1:
            raise HTTPException(
                status_code=503,
                detail="Multiple Board Yjs host nodes are registered",
            )
        return hosts[0]

    async def _request_board_yjs_host_node(
        request: Request,
        method: Literal["POST", "PUT", "PATCH", "DELETE"],
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        node = _resolve_board_yjs_host_node()
        headers = forward_auth_headers(request)
        async with httpx.AsyncClient(timeout=10.0) as client:
            url = f"http://{node.host}:{node.port}{path}"
            try:
                resp = await client.request(method, url, json=json_body, headers=headers)
            except httpx.RequestError as exc:
                logger.warning(
                    "%s board Yjs host proxy failed: node=%s url=%s error=%s",
                    path,
                    node.node_id,
                    url,
                    exc,
                )
                raise HTTPException(status_code=502, detail="Board Yjs host node is unreachable") from exc
        return resp

    def _node_response(resp: httpx.Response):
        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            return JSONResponse(status_code=resp.status_code, content=resp.json())
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=content_type or None,
        )

    @router.post("/board-yjs/host/{operation}")
    async def proxy_board_yjs_host_operation(operation: str, request: Request):
        payload = await request.json()
        resp = await _request_board_yjs_host_node(
            request,
            "POST",
            f"/api/internal/board-yjs/{quote(operation, safe='')}",
            json_body=payload,
        )
        return _node_response(resp)

    @router.get("/board-items")
    async def list_board_items(
        request: Request,
        folder_id: Optional[str] = Query(None),
        container_kind: Optional[Literal["folder", "runbook"]] = Query(None),
        container_id: Optional[str] = Query(None),
    ) -> dict:
        """현재 컨테이너의 보드 항목만 조회한다."""
        folders = await catalog_service.list_folders()
        if folder_id is not None:
            if container_kind is not None or container_id is not None:
                raise HTTPException(
                    status_code=400,
                    detail="folder_id and container_kind/container_id are mutually exclusive",
                )
            inherited_folder_id = folder_id
        else:
            if container_kind is None or container_id is None:
                raise HTTPException(
                    status_code=400,
                    detail="folder_id or container_kind/container_id is required",
                )
            resolved_kind = container_kind
            resolved_id = container_id
            inherited_folder_id = await _resolve_board_container_folder_id(
                catalog_service,
                container_kind,
                container_id,
            )
        require_folder_allowed(access_for_request(request), folders, inherited_folder_id)
        if folder_id is not None:
            board_items = await catalog_service.list_board_items(folder_id=folder_id)
        else:
            board_items = await catalog_service.list_board_items(
                container_kind=container_kind,
                container_id=container_id,
            )
        return {"boardItems": board_items}

    @router.patch("/board-items/{board_item_id}/position")
    async def update_board_item_position(
        request: Request,
        board_item_id: str,
        body: BoardItemPositionUpdate,
    ) -> dict:
        access = access_for_request(request)
        if access.restricted:
            catalog = await catalog_service.get_catalog()
            folders = catalog.get("folders") if isinstance(catalog.get("folders"), list) else []
            board_items = catalog.get("boardItems") if isinstance(catalog.get("boardItems"), list) else []
            board_item = next((item for item in board_items if item.get("id") == board_item_id), None)
            if board_item is None:
                raise HTTPException(status_code=404, detail="Board item not found")
            require_folder_allowed(access, folders, board_item.get("folderId"))
        resp = await _request_board_yjs_host_node(
            request,
            "PATCH",
            f"/api/board-items/{quote(board_item_id, safe='')}/position",
            json_body={"x": body.x, "y": body.y},
        )
        return _node_response(resp)

    @router.patch("/board-items/{board_item_id}/container")
    async def move_board_item_to_container(
        request: Request,
        board_item_id: str,
        body: BoardItemContainerMove,
    ):
        if (body.x is None) != (body.y is None):
            raise HTTPException(status_code=422, detail="x and y must be supplied together")
        catalog = await catalog_service.get_catalog()
        folders = catalog.get("folders") if isinstance(catalog.get("folders"), list) else []
        board_items = catalog.get("boardItems") if isinstance(catalog.get("boardItems"), list) else []
        board_item = next(
            (item for item in board_items if isinstance(item, dict) and item.get("id") == board_item_id),
            None,
        )
        if board_item is None:
            raise HTTPException(status_code=404, detail="Board item not found")

        access = access_for_request(request)
        require_folder_allowed(access, folders, board_item.get("folderId"))
        target_folder_id = await _resolve_board_container_folder_id(
            catalog_service,
            body.container.kind,
            body.container.id,
        )
        require_folder_allowed(access, folders, target_folder_id)

        payload: dict[str, Any] = {
            "container": {
                "kind": body.container.kind,
                "id": body.container.id,
            },
            "idempotencyKey": body.idempotency_key,
        }
        if body.x is not None and body.y is not None:
            payload["x"] = body.x
            payload["y"] = body.y

        resp = await _request_board_yjs_host_node(
            request,
            "PATCH",
            f"/api/board-items/{quote(board_item_id, safe='')}/container",
            json_body=payload,
        )
        return _node_response(resp)

    @router.post("/markdown-documents", status_code=201)
    async def create_markdown_document(body: MarkdownDocumentCreate, request: Request) -> dict:
        folder_id, container_kind, container_id = await _resolve_body_board_container(
            catalog_service,
            body.folderId,
            body.container,
        )
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        payload = {
            "folderId": folder_id,
            "container": {
                "kind": container_kind,
                "id": container_id,
            },
            "title": body.title,
            "body": body.body,
        }
        if body.x is not None and body.y is not None:
            payload["x"] = body.x
            payload["y"] = body.y
        resp = await _request_board_yjs_host_node(
            request,
            "POST",
            "/api/markdown-documents",
            json_body=payload,
        )
        return _node_response(resp)

    @router.get("/markdown-documents/{document_id}")
    async def get_markdown_document(document_id: str, request: Request) -> dict:
        document = await catalog_service.get_markdown_document(document_id)
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found")
        folder_id = document.get("folderId") or document.get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        return document

    @router.get("/custom-views/{custom_view_id}")
    async def get_custom_view(custom_view_id: str, request: Request) -> dict:
        custom_view = await catalog_service.get_custom_view(custom_view_id)
        if custom_view is None:
            raise HTTPException(status_code=404, detail="Custom view not found")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, custom_view.get("folderId"))
        return custom_view

    @router.get("/runbooks/my-turn")
    async def get_runbook_my_turn(request: Request, limit: int = Query(100, ge=1, le=500)) -> dict:
        loader = getattr(db, "get_runbook_overview", None)
        if loader is None:
            raise HTTPException(status_code=503, detail="Runbook storage is not configured")
        folders = await catalog_service.list_folders()
        overview = await loader(user_id=_dashboard_user_id_for_request(request), limit=limit)
        allowed_ids = visible_folder_ids(access_for_request(request), folders)
        return _filter_runbook_overview_for_access(overview, allowed_ids)

    @router.post("/runbooks/{runbook_id}/items/{item_id}/status")
    async def proxy_runbook_item_status(
        runbook_id: str,
        item_id: str,
        body: RunbookItemStatusMutation,
        request: Request,
    ):
        loader = getattr(db, "get_runbook_snapshot", None)
        if loader is None or node_manager is None:
            raise HTTPException(status_code=503, detail="Runbook storage is not configured")

        snapshot = await loader(runbook_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="Runbook not found")
        folder_id = (snapshot.get("runbook") or {}).get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)

        if not _snapshot_has_item(snapshot, item_id):
            raise HTTPException(status_code=404, detail="Runbook item not found")

        actor_session_id = _resolve_actor_session_id(snapshot, item_id)
        if actor_session_id is None:
            raise HTTPException(status_code=422, detail="Runbook item has no session provenance")

        node = await _resolve_runbook_mutation_node(actor_session_id, db, node_manager)
        url = (
            f"http://{node.host}:{node.port}"
            f"/api/runbooks/{quote(runbook_id, safe='')}"
            f"/items/{quote(item_id, safe='')}/status"
        )
        payload = {
            "status": body.status,
            "expectedVersion": body.expected_version,
            "idempotencyKey": body.idempotency_key,
        }
        if body.reason is not None:
            payload["reason"] = body.reason

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    url,
                    json=payload,
                    headers=forward_auth_headers(request),
                )
        except httpx.RequestError:
            return Response(status_code=502)

        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            return JSONResponse(status_code=resp.status_code, content=resp.json())
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=content_type or None,
        )

    @router.post("/runbooks/{runbook_id}/status")
    async def proxy_runbook_status(
        runbook_id: str,
        body: RunbookStatusMutation,
        request: Request,
    ):
        loader = getattr(db, "get_runbook_snapshot", None)
        if loader is None or node_manager is None:
            raise HTTPException(status_code=503, detail="Runbook storage is not configured")

        snapshot = await loader(runbook_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="Runbook not found")
        folder_id = (snapshot.get("runbook") or {}).get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)

        actor_session_id = _resolve_runbook_actor_session_id(snapshot)
        if actor_session_id is None:
            raise HTTPException(status_code=422, detail="Runbook has no session provenance")

        node = await _resolve_runbook_mutation_node(actor_session_id, db, node_manager)
        url = (
            f"http://{node.host}:{node.port}"
            f"/api/runbooks/{quote(runbook_id, safe='')}/status"
        )
        payload = {
            "status": body.status,
            "expectedVersion": body.expected_version,
            "idempotencyKey": body.idempotency_key,
        }
        if body.reason is not None:
            payload["reason"] = body.reason

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    url,
                    json=payload,
                    headers=forward_auth_headers(request),
                )
        except httpx.RequestError:
            return Response(status_code=502)

        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            return JSONResponse(status_code=resp.status_code, content=resp.json())
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            media_type=content_type or None,
        )

    @router.get("/runbooks/{runbook_id}")
    async def get_runbook(runbook_id: str, request: Request) -> dict:
        loader = getattr(db, "get_runbook_snapshot", None)
        if loader is None:
            raise HTTPException(status_code=503, detail="Runbook storage is not configured")
        snapshot = await loader(runbook_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="Runbook not found")
        folder_id = (snapshot.get("runbook") or {}).get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        return snapshot

    @router.put("/markdown-documents/{document_id}")
    async def update_markdown_document(
        document_id: str,
        body: MarkdownDocumentUpdate,
        request: Request,
    ) -> dict:
        has_title = _field_supplied(body, "title") and body.title is not None
        has_body = _field_supplied(body, "body") and body.body is not None
        if not has_title and not has_body:
            raise HTTPException(status_code=400, detail="No fields to update")
        existing = await catalog_service.get_markdown_document(document_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Document not found")
        folder_id = existing.get("folderId") or existing.get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        payload: dict[str, Any] = {
            "expectedVersion": body.expected_version,
        }
        if has_title:
            payload["title"] = body.title
        if has_body:
            payload["body"] = body.body
        resp = await _request_board_yjs_host_node(
            request,
            "PUT",
            f"/api/markdown-documents/{quote(document_id, safe='')}",
            json_body=payload,
        )
        return _node_response(resp)

    @router.delete("/markdown-documents/{document_id}", status_code=204)
    async def delete_markdown_document(document_id: str, request: Request):
        existing = await catalog_service.get_markdown_document(document_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Document not found")
        folder_id = existing.get("folderId") or existing.get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        resp = await _request_board_yjs_host_node(
            request,
            "DELETE",
            f"/api/markdown-documents/{quote(document_id, safe='')}",
        )
        return _node_response(resp)

    @router.post("/board/{folder_id}/assets/init", status_code=201)
    async def init_board_asset(folder_id: str, body: BoardAssetInit, request: Request) -> dict:
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        try:
            return await catalog_service.init_file_asset(
                folder_id=folder_id,
                name=body.name,
                mime_type=body.mime,
                byte_size=body.size,
            )
        except (RuntimeError, ValueError) as exc:
            raise _board_asset_error(exc) from exc

    @router.post("/board-containers/{container_kind}/{container_id}/assets/init", status_code=201)
    async def init_container_board_asset(
        container_kind: Literal["folder", "runbook"],
        container_id: str,
        body: BoardAssetInit,
        request: Request,
    ) -> dict:
        folder_id = await _resolve_board_container_folder_id(
            catalog_service,
            container_kind,
            container_id,
        )
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        try:
            return await catalog_service.init_file_asset(
                folder_id=folder_id,
                name=body.name,
                mime_type=body.mime,
                byte_size=body.size,
                container_kind=container_kind,
                container_id=container_id,
            )
        except (RuntimeError, ValueError) as exc:
            raise _board_asset_error(exc) from exc

    @router.post("/board/{folder_id}/assets/{asset_id}/commit")
    async def commit_board_asset(
        folder_id: str,
        asset_id: str,
        body: BoardAssetCommit,
        request: Request,
    ) -> dict:
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        try:
            return await catalog_service.commit_file_asset(
                folder_id=folder_id,
                asset_id=asset_id,
                x=body.x,
                y=body.y,
                width=body.width,
                height=body.height,
                duration_seconds=body.durationSeconds,
                parts=[part.model_dump() for part in body.parts],
            )
        except (RuntimeError, ValueError) as exc:
            raise _board_asset_error(exc) from exc

    @router.post("/board-containers/{container_kind}/{container_id}/assets/{asset_id}/commit")
    async def commit_container_board_asset(
        container_kind: Literal["folder", "runbook"],
        container_id: str,
        asset_id: str,
        body: BoardAssetCommit,
        request: Request,
    ) -> dict:
        folder_id = await _resolve_board_container_folder_id(
            catalog_service,
            container_kind,
            container_id,
        )
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        try:
            return await catalog_service.commit_file_asset(
                folder_id=folder_id,
                asset_id=asset_id,
                x=body.x,
                y=body.y,
                width=body.width,
                height=body.height,
                duration_seconds=body.durationSeconds,
                parts=[part.model_dump() for part in body.parts],
                container_kind=container_kind,
                container_id=container_id,
            )
        except (RuntimeError, ValueError) as exc:
            raise _board_asset_error(exc) from exc

    return router


def _snapshot_has_item(snapshot: dict, item_id: str) -> bool:
    items = snapshot.get("items")
    if not isinstance(items, list):
        return False
    return any(isinstance(item, dict) and item.get("id") == item_id for item in items)


def _resolve_runbook_actor_session_id(snapshot: dict) -> str | None:
    runbook = snapshot.get("runbook") or {}
    if not isinstance(runbook, dict):
        return None
    for value in (
        runbook.get("completed_session_id"),
        runbook.get("created_session_id"),
    ):
        if isinstance(value, str) and value:
            return value
    return None


def _resolve_actor_session_id(snapshot: dict, item_id: str) -> str | None:
    item = _snapshot_item(snapshot, item_id)
    if item is None:
        return None
    section = _snapshot_section(snapshot, item.get("section_id"))
    for value in (
        item.get("assignee_session_id"),
        item.get("updated_session_id"),
        item.get("created_session_id"),
        (section or {}).get("updated_session_id"),
        (section or {}).get("created_session_id"),
        (snapshot.get("runbook") or {}).get("created_session_id"),
    ):
        if isinstance(value, str) and value:
            return value
    return None


async def _resolve_runbook_mutation_node(actor_session_id: str, db, node_manager):
    try:
        return await find_session_node(actor_session_id, db, node_manager)
    except HTTPException as exc:
        if exc.status_code not in {404, 503}:
            raise
        connected_nodes = node_manager.get_connected_nodes()
        if not connected_nodes:
            raise HTTPException(
                status_code=503,
                detail="No connected soul-server node available for runbook mutation",
            ) from exc
        fallback = connected_nodes[0]
        logger.info(
            "Runbook actor session %s is not routable (%s); forwarding to connected node %s",
            actor_session_id,
            exc.detail,
            fallback.node_id,
        )
        return fallback


def _snapshot_item(snapshot: dict, item_id: str) -> dict | None:
    items = snapshot.get("items")
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and item.get("id") == item_id:
            return item
    return None


def _snapshot_section(snapshot: dict, section_id: object) -> dict | None:
    if not isinstance(section_id, str):
        return None
    sections = snapshot.get("sections")
    if not isinstance(sections, list):
        return None
    for section in sections:
        if isinstance(section, dict) and section.get("id") == section_id:
            return section
    return None
