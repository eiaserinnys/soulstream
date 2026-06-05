"""
Catalog API 라우터 — /api/catalog

폴더 + 세션 통합 카탈로그 조회.

응답 형식:
- folders: [{id, name, sortOrder}]
- sessions: Record<string, {folderId, displayName}>  — soul-ui CatalogState 호환
- sessionList: _session_to_response 정본 helper와 동일한 camelCase 응답
  (agentSessionId, nodeId, folderId, displayName, lastMessage, status, sessionType,
   createdAt, updatedAt, lastEventId, lastReadEventId, prompt, agentId, agentName,
   agentPortraitUrl, backend, userName, userPortraitUrl, callerSessionId, clientId,
   metadata).

Phase A-bis(2026-05-16): sessionList build를 _session_to_response helper 호출로
통일. 정본 둘 안티패턴(atom d7a1ad86) 차단 — agent/caller/user profile/backend
처리가 한 자리에서 동기된다. 응답 키 케이스도 camelCase로 통일.

soul-common의 CatalogService.get_catalog()은 sessions를 dict(세션ID → 폴더배정)으로
반환하므로, 오케스트레이터에서는 DB 세션 목록과 폴더 배정을 병합하여 두 가지 형식으로 제공한다.
- sessions dict: soul-ui의 useSessionListProvider가 setCatalog(data)로 사용
- sessionList 배열: OrchestratorSessionProvider가 세션 목록 구성에 사용
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB
from soulstream_server.api.session_serializer import _session_to_response
from soulstream_server.models import BatchMoveRequest
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


class SessionCatalogUpdate(BaseModel):
    folderId: Optional[str] = None
    displayName: Optional[str] = None


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


def _field_supplied(model: BaseModel, field_name: str) -> bool:
    fields = getattr(model, "model_fields_set", None)
    if fields is None:
        fields = getattr(model, "__fields_set__", set())
    return field_name in fields


def create_catalog_router(
    catalog_service: CatalogService,
    db: PostgresSessionDB,
    node_manager: NodeManager,
    dependencies: list | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/catalog",
        tags=["catalog"],
        dependencies=dependencies or [],
    )

    @router.get("")
    async def get_catalog(
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=0),
        folder_id: Optional[str] = None,
        feed_only: bool = Query(False),
    ) -> dict:
        """폴더 + 세션 카탈로그 조회.

        soul-common의 카탈로그(폴더 배정 맵)와 DB 세션 목록을 병합하여
        orchestrator-dashboard가 기대하는 배열 형식으로 반환한다.
        """
        # 폴더 + 세션→폴더 배정 맵
        catalog = await catalog_service.get_catalog()
        folder_assignments = catalog.get("sessions", {})

        # DB에서 세션 목록 조회 (페이지네이션 적용, limit=0이면 전체)
        sessions_raw, total = await db.get_all_sessions(offset=offset, limit=limit, folder_id=folder_id, feed_only=feed_only)

        # sessions dict: soul-ui CatalogState 호환 (Record<string, CatalogAssignment>)
        # folder_assignments 전체를 사용한다. sessions_raw는 페이지네이션되어 있어
        # 여기서 사용하면 51번째 이후 세션의 폴더 배정이 누락된다.
        sessions_dict = {
            sid: {
                "folderId": assignment.get("folderId"),
                "displayName": assignment.get("displayName"),
            }
            for sid, assignment in folder_assignments.items()
        }

        # sessionList 배열: 정본 helper(_session_to_response)로 단일화.
        # folder_id·display_name은 catalog folder_assignments가 *정본*이므로
        # row에 spread copy로 덮어쓴 후 helper에 전달한다 (원본 row 비변형).
        # 응답은 camelCase 통일 — OrchestratorSessionProvider가 동일 키로 수신.
        session_list = []
        for s in sessions_raw:
            sid = s.get("session_id", "")
            assignment = folder_assignments.get(sid, {})
            s_enriched = {
                **s,
                "folder_id": assignment.get("folderId"),
                "display_name": assignment.get("displayName"),
            }
            session_list.append(_session_to_response(s_enriched, node_manager))

        return {
            "folders": catalog.get("folders", []),
            "sessions": sessions_dict,
            "boardItems": catalog.get("boardItems", []),
            "sessionList": session_list,
            "total": total,
        }

    @router.get("/folder-counts")
    async def get_folder_counts_endpoint() -> dict:
        """폴더별 세션 수 조회 (GET /api/catalog/folder-counts)

        soulstream-server는 오케스트레이터이므로 node_id=None으로 전체 집계한다.
        """
        counts = await db.get_folder_counts(node_id=None)
        # None 키(폴더 미지정)는 JSON 직렬화 시 "null" 문자열로 변환
        return {"counts": {str(k) if k is not None else "null": v for k, v in counts.items()}}

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

    # 고정 경로 "/sessions/batch"를 파라미터화 경로 "/{session_id}" 보다 먼저 등록
    @router.put("/sessions/batch")
    async def batch_move_sessions(body: BatchMoveRequest) -> dict:
        """세션 일괄 폴더 이동."""
        await catalog_service.move_sessions_to_folder(body.sessionIds, body.folderId)
        return {"ok": True}

    @router.put("/sessions/{session_id}")
    async def update_session_catalog(session_id: str, body: SessionCatalogUpdate) -> dict:
        """세션 폴더 이동 + 이름 변경 (개별)."""
        if body.folderId is not None:
            await catalog_service.move_sessions_to_folder([session_id], body.folderId)
        if body.displayName is not None:
            await catalog_service.rename_session(session_id, body.displayName)
        return {"ok": True}

    @router.delete("/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: str):
        """세션 삭제."""
        await catalog_service.delete_session(session_id)

    return router
