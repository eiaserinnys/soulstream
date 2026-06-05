"""
Board and markdown API routes.

The old catalog route mixed folders, session list, board items, and
folder assignment state in one payload. Query responsibilities are now split:
folders live under `/api/folders`, sessions under `/api/sessions`, and board
workspace data under `/api/board-items` and `/api/markdown-documents`.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from soul_common.catalog.catalog_service import CatalogService

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
    async def list_board_items(folder_id: str = Query(...)) -> dict:
        """현재 폴더의 보드 항목만 조회한다."""
        board_items = await catalog_service.list_board_items(folder_id)
        return {"boardItems": board_items}

    @router.patch("/board-items/{board_item_id}/position")
    async def update_board_item_position(board_item_id: str, body: BoardItemPositionUpdate) -> dict:
        await catalog_service.update_board_item_position(board_item_id, body.x, body.y)
        return {"ok": True}

    @router.post("/markdown-documents", status_code=201)
    async def create_markdown_document(body: MarkdownDocumentCreate) -> dict:
        return await catalog_service.create_markdown_document(
            folder_id=body.folderId,
            title=body.title,
            body=body.body,
            x=body.x,
            y=body.y,
        )

    @router.get("/markdown-documents/{document_id}")
    async def get_markdown_document(document_id: str) -> dict:
        document = await catalog_service.get_markdown_document(document_id)
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return document

    @router.put("/markdown-documents/{document_id}")
    async def update_markdown_document(document_id: str, body: MarkdownDocumentUpdate) -> dict:
        if not _field_supplied(body, "title") and not _field_supplied(body, "body"):
            raise HTTPException(status_code=400, detail="No fields to update")
        document = await catalog_service.update_markdown_document(
            document_id,
            title=body.title if _field_supplied(body, "title") else None,
            body=body.body if _field_supplied(body, "body") else None,
        )
        if document is None:
            raise HTTPException(status_code=404, detail="Document not found")
        return document

    @router.delete("/markdown-documents/{document_id}", status_code=204)
    async def delete_markdown_document(document_id: str):
        await catalog_service.delete_markdown_document(document_id)

    @router.post("/board/{folder_id}/assets/init", status_code=201)
    async def init_board_asset(folder_id: str, body: BoardAssetInit) -> dict:
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
    async def commit_board_asset(folder_id: str, asset_id: str, body: BoardAssetCommit) -> dict:
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
