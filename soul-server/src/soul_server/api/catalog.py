"""
Catalog API - 폴더 카탈로그 관리

세션을 폴더로 분류·관리하는 카탈로그 API.
CatalogService를 경유하여 비즈니스 로직 중복을 제거한다.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from soul_server.service.catalog_service import CatalogService


class FolderCreate(BaseModel):
    name: str
    sort_order: int = 0
    parentFolderId: Optional[str] = None


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None
    settings: Optional[dict] = None
    parentFolderId: Optional[str] = None


class SessionCatalogUpdate(BaseModel):
    folderId: Optional[str] = None
    displayName: Optional[str] = None


class FolderReorderItem(BaseModel):
    id: str
    sortOrder: int
    parentFolderId: Optional[str] = None


class BatchMoveRequest(BaseModel):
    sessionIds: list[str]
    folderId: Optional[str]


def _field_supplied(model: BaseModel, field_name: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field_name in fields


def create_catalog_router(catalog_service: CatalogService) -> APIRouter:
    router = APIRouter()

    @router.get("")
    async def get_catalog():
        return await catalog_service.get_catalog()

    @router.post("/folders", status_code=201)
    async def create_folder(body: FolderCreate):
        return await catalog_service.create_folder(
            body.name,
            body.sort_order,
            parent_folder_id=body.parentFolderId,
        )

    @router.put("/folders/{folder_id}")
    async def update_folder(folder_id: str, body: FolderUpdate):
        parent_supplied = _field_supplied(body, "parentFolderId")
        if body.name is None and body.sort_order is None and body.settings is None and not parent_supplied:
            raise HTTPException(status_code=400, detail="No fields to update")
        kwargs = {
            "name": body.name,
            "sort_order": body.sort_order,
            "settings": body.settings,
        }
        if parent_supplied:
            kwargs["parent_folder_id"] = body.parentFolderId
        await catalog_service.update_folder(folder_id, **kwargs)
        return {"ok": True}

    @router.patch("/folders/reorder")
    async def reorder_folders(body: list[FolderReorderItem]):
        payload = []
        for item in body:
            entry = {"id": item.id, "sortOrder": item.sortOrder}
            if _field_supplied(item, "parentFolderId"):
                entry["parentFolderId"] = item.parentFolderId
            payload.append(entry)
        await catalog_service.reorder_folders(payload)
        return {"ok": True}

    @router.delete("/folders/{folder_id}", status_code=204)
    async def delete_folder(folder_id: str):
        await catalog_service.delete_folder(folder_id)

    # 固定パス "/sessions/batch" を先に登録し、
    # パスパラメータ "/sessions/{session_id}" が "batch" にマッチしないようにする
    @router.put("/sessions/batch")
    async def batch_move_sessions(body: BatchMoveRequest):
        await catalog_service.move_sessions_to_folder(
            body.sessionIds, body.folderId,
        )
        return {"ok": True}

    @router.put("/sessions/{session_id}")
    async def update_session_catalog(session_id: str, body: SessionCatalogUpdate):
        if body.folderId is not None:
            await catalog_service.move_sessions_to_folder(
                [session_id], body.folderId,
            )
        if body.displayName is not None:
            await catalog_service.rename_session(session_id, body.displayName)
        return {"ok": True}

    @router.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: str):
        await catalog_service.delete_session(session_id)

    return router
