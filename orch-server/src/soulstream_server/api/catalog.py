"""
Board and markdown API routes.

The old catalog route mixed folders, session list, board items, and
folder assignment state in one payload. Query responsibilities are now split:
folders live under `/api/folders`, sessions under `/api/sessions`, and board
workspace data under `/api/board-items` and `/api/markdown-documents`.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from soul_common.catalog.catalog_service import (
    CatalogService,
    MarkdownDocumentVersionConflictError,
)
from soulstream_server.dashboard_access import access_for_request, require_folder_allowed

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


def _board_asset_error(exc: Exception) -> HTTPException:
    if isinstance(exc, RuntimeError):
        return HTTPException(status_code=503, detail=str(exc))
    detail = str(exc)
    if "size" in detail or "quota" in detail:
        return HTTPException(status_code=413, detail=detail)
    return HTTPException(status_code=400, detail=detail)


def create_catalog_router(
    catalog_service: CatalogService,
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
