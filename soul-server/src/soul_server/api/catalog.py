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


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None


class SessionCatalogUpdate(BaseModel):
    folderId: Optional[str] = None
    displayName: Optional[str] = None


class BatchMoveRequest(BaseModel):
    sessionIds: list[str]
    folderId: Optional[str]


def create_catalog_router(catalog_service: CatalogService) -> APIRouter:
    router = APIRouter()

    @router.get("")
    async def get_catalog():
        return await catalog_service.get_catalog()

    @router.post("/folders", status_code=201)
    async def create_folder(body: FolderCreate):
        return await catalog_service.create_folder(body.name, body.sort_order)

    @router.put("/folders/{folder_id}")
    async def update_folder(folder_id: str, body: FolderUpdate):
        if body.name is None and body.sort_order is None:
            raise HTTPException(status_code=400, detail="No fields to update")
        await catalog_service.update_folder(
            folder_id, name=body.name, sort_order=body.sort_order,
        )
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
