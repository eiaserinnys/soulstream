"""
Folders API 라우터 — /api/folders

폴더 CRUD.
"""

import logging
from inspect import isawaitable
from typing import Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel

from soul_common.catalog.catalog_service import CatalogService
from soulstream_server.dashboard_access import (
    access_for_request,
    filter_folders,
    filter_session_assignments,
    require_folder_allowed,
)

logger = logging.getLogger(__name__)


class CreateFolderRequest(BaseModel):
    name: str
    sortOrder: int = 0
    parentFolderId: Optional[str] = None


class UpdateFolderRequest(BaseModel):
    name: Optional[str] = None
    sortOrder: Optional[int] = None
    settings: Optional[dict] = None
    parentFolderId: Optional[str] = None


class FolderReorderItem(BaseModel):
    id: str
    sortOrder: int
    parentFolderId: Optional[str] = None


def _field_supplied(model: BaseModel, field_name: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field_name in fields


def create_folders_router(
    catalog_service: CatalogService,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/folders",
        tags=["folders"],
        dependencies=dependencies or [],
    )

    @router.get("")
    async def list_folders(request: Request) -> dict:
        """폴더 목록 조회."""
        access = access_for_request(request)
        folders = await catalog_service.list_folders()
        assignments = {}
        list_assignments = getattr(catalog_service, "list_session_assignments", None) if access.restricted else None
        if list_assignments is not None:
            assignment_result = list_assignments()
            assignments = await assignment_result if isawaitable(assignment_result) else assignment_result
        return {
            "folders": filter_folders(access, folders),
            "sessions": filter_session_assignments(access, folders, assignments),
            "access": access.to_payload(),
        }

    @router.post("", status_code=201)
    async def create_folder(body: CreateFolderRequest, request: Request) -> dict:
        """폴더 생성."""
        access = access_for_request(request)
        folders = await catalog_service.list_folders()
        require_folder_allowed(access, folders, body.parentFolderId)
        folder = await catalog_service.create_folder(
            body.name,
            body.sortOrder,
            parent_folder_id=body.parentFolderId,
        )
        return folder

    @router.put("/{folder_id}")
    async def update_folder(folder_id: str, body: UpdateFolderRequest, request: Request) -> dict:
        """폴더 업데이트 (이름/설정 변경)."""
        access = access_for_request(request)
        folders = await catalog_service.list_folders()
        require_folder_allowed(access, folders, folder_id)
        parent_supplied = _field_supplied(body, "parentFolderId")
        kwargs = {
            "name": body.name,
            "sort_order": body.sortOrder,
            "settings": body.settings,
        }
        if parent_supplied:
            require_folder_allowed(access, folders, body.parentFolderId)
            kwargs["parent_folder_id"] = body.parentFolderId
        await catalog_service.update_folder(folder_id, **kwargs)
        return {"success": True}

    @router.delete("/{folder_id}")
    async def delete_folder(folder_id: str, request: Request) -> dict:
        """폴더 삭제. 소속 세션은 미배정으로 이동."""
        access = access_for_request(request)
        folders = await catalog_service.list_folders()
        require_folder_allowed(access, folders, folder_id)
        await catalog_service.delete_folder(folder_id)
        return {"success": True}

    @router.patch("/reorder")
    async def reorder_folders(body: list[FolderReorderItem], request: Request) -> dict:
        """폴더 순서 일괄 변경."""
        access = access_for_request(request)
        folders = await catalog_service.list_folders()
        payload = []
        for item in body:
            require_folder_allowed(access, folders, item.id)
            entry = {"id": item.id, "sortOrder": item.sortOrder}
            if _field_supplied(item, "parentFolderId"):
                require_folder_allowed(access, folders, item.parentFolderId)
                entry["parentFolderId"] = item.parentFolderId
            payload.append(entry)
        await catalog_service.reorder_folders(payload)
        return {"success": True}

    return router
