"""
Board and markdown API routes.

The old catalog route mixed folders, session list, board items, and
folder assignment state in one payload. Query responsibilities are now split:
folders live under `/api/folders`, sessions under `/api/sessions`, and board
workspace data under `/api/board-items` and `/api/markdown-documents`.
"""

import logging
from typing import Literal, Optional
from urllib.parse import quote

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from soulstream_server.api._proxy_utils import forward_auth_headers
from soulstream_server.api.node_utils import find_session_node
from soul_common.catalog.catalog_service import (
    CatalogService,
    MarkdownDocumentVersionConflictError,
)
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


class MarkdownDocumentCreate(BaseModel):
    folderId: str
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

    status: Literal["pending", "completed", "cancelled"]
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

    @router.get("/board-items")
    async def list_board_items(request: Request, folder_id: str = Query(...)) -> dict:
        """현재 폴더의 보드 항목만 조회한다."""
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        board_items = await catalog_service.list_board_items(folder_id)
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
        await catalog_service.update_board_item_position(board_item_id, body.x, body.y)
        return {"ok": True}

    @router.post("/markdown-documents", status_code=201)
    async def create_markdown_document(body: MarkdownDocumentCreate, request: Request) -> dict:
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, body.folderId)
        return await catalog_service.create_markdown_document(
            folder_id=body.folderId,
            title=body.title,
            body=body.body,
            x=body.x,
            y=body.y,
        )

    @router.get("/markdown-documents/{document_id}")
    async def get_markdown_document(document_id: str, request: Request) -> dict:
        document = await catalog_service.get_markdown_document(document_id)
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found")
        folder_id = document.get("folderId") or document.get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        return document

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
        try:
            document = await catalog_service.update_markdown_document(
                document_id,
                title=body.title if has_title else None,
                body=body.body if has_body else None,
                expected_version=body.expected_version,
            )
        except MarkdownDocumentVersionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return document

    @router.delete("/markdown-documents/{document_id}", status_code=204)
    async def delete_markdown_document(document_id: str, request: Request):
        existing = await catalog_service.get_markdown_document(document_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Document not found")
        folder_id = existing.get("folderId") or existing.get("folder_id")
        folders = await catalog_service.list_folders()
        require_folder_allowed(access_for_request(request), folders, folder_id)
        await catalog_service.delete_markdown_document(document_id)

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

    return router


def _snapshot_has_item(snapshot: dict, item_id: str) -> bool:
    items = snapshot.get("items")
    if not isinstance(items, list):
        return False
    return any(isinstance(item, dict) and item.get("id") == item_id for item in items)


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
