"""
Catalog API - 폴더 카탈로그 관리

세션을 폴더로 분류·관리하는 카탈로그 API.
"""

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from soul_server.service.session_db import SessionDB
from soul_server.service.session_broadcaster import SessionBroadcaster


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


def create_catalog_router(
    session_db: SessionDB, broadcaster: SessionBroadcaster
) -> APIRouter:
    router = APIRouter()

    def _broadcast_catalog():
        catalog = session_db.get_catalog()
        broadcaster.broadcast({
            "type": "catalog_updated",
            "catalog": catalog,
        })

    @router.get("")
    async def get_catalog():
        return session_db.get_catalog()

    @router.post("/folders", status_code=201)
    async def create_folder(body: FolderCreate):
        folder_id = str(uuid.uuid4())
        session_db.create_folder(folder_id, body.name, body.sort_order)
        _broadcast_catalog()
        return {"id": folder_id, "name": body.name, "sortOrder": body.sort_order}

    @router.put("/folders/{folder_id}")
    async def update_folder(folder_id: str, body: FolderUpdate):
        fields = {}
        if body.name is not None:
            fields["name"] = body.name
        if body.sort_order is not None:
            fields["sort_order"] = body.sort_order
        if not fields:
            raise HTTPException(status_code=400, detail="No fields to update")
        session_db.update_folder(folder_id, **fields)
        _broadcast_catalog()
        return {"ok": True}

    @router.delete("/folders/{folder_id}", status_code=204)
    async def delete_folder(folder_id: str):
        session_db.delete_folder(folder_id)
        _broadcast_catalog()

    @router.put("/sessions/{session_id}")
    async def update_session_catalog(session_id: str, body: SessionCatalogUpdate):
        session = session_db.get_session(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        if body.folderId is not None:
            session_db.assign_session_to_folder(session_id, body.folderId)
        if body.displayName is not None:
            session_db.rename_session(session_id, body.displayName)
        _broadcast_catalog()
        return {"ok": True}

    @router.put("/sessions/batch")
    async def batch_move_sessions(body: BatchMoveRequest):
        for sid in body.sessionIds:
            session_db.assign_session_to_folder(sid, body.folderId)
        _broadcast_catalog()
        return {"ok": True}

    return router
