"""
Folders API 라우터 — /api/catalog/folders

폴더 CRUD.
"""

import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from soul_common.catalog.catalog_service import CatalogService

logger = logging.getLogger(__name__)


class CreateFolderRequest(BaseModel):
    name: str
    sortOrder: int = 0


class UpdateFolderRequest(BaseModel):
    name: Optional[str] = None
    sortOrder: Optional[int] = None
    settings: Optional[dict] = None


def create_folders_router(catalog_service: CatalogService) -> APIRouter:
    router = APIRouter(prefix="/api/catalog/folders", tags=["folders"])

    @router.get("")
    async def list_folders() -> dict:
        """폴더 목록 조회."""
        folders = await catalog_service.list_folders()
        return {"folders": folders}

    @router.post("", status_code=201)
    async def create_folder(body: CreateFolderRequest) -> dict:
        """폴더 생성."""
        folder = await catalog_service.create_folder(body.name, body.sortOrder)
        return folder

    @router.put("/{folder_id}")
    async def update_folder(folder_id: str, body: UpdateFolderRequest) -> dict:
        """폴더 업데이트 (이름/설정 변경)."""
        await catalog_service.update_folder(
            folder_id,
            name=body.name,
            sort_order=body.sortOrder,
            settings=body.settings,
        )
        return {"success": True}

    @router.delete("/{folder_id}")
    async def delete_folder(folder_id: str) -> dict:
        """폴더 삭제. 소속 세션은 미배정으로 이동."""
        await catalog_service.delete_folder(folder_id)
        return {"success": True}

    return router
