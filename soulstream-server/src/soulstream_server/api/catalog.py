"""
Catalog API 라우터 — /api/catalog

폴더 + 세션 통합 카탈로그 조회.

응답 형식:
- folders: [{id, name, sortOrder}]
- sessions: Record<string, {folderId, displayName}>  — soul-ui CatalogState 호환
- sessionList: [{session_id, node_id, folder_id, display_name, last_message, status, created_at, updated_at}]

soul-common의 CatalogService.get_catalog()은 sessions를 dict(세션ID → 폴더배정)으로
반환하므로, 오케스트레이터에서는 DB 세션 목록과 폴더 배정을 병합하여 두 가지 형식으로 제공한다.
- sessions dict: soul-ui의 useSessionListProvider가 setCatalog(data)로 사용
- sessionList 배열: OrchestratorSessionProvider가 세션 목록 구성에 사용
"""

import logging

from fastapi import APIRouter

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB

logger = logging.getLogger(__name__)


def create_catalog_router(
    catalog_service: CatalogService,
    db: PostgresSessionDB,
) -> APIRouter:
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

    @router.get("")
    async def get_catalog() -> dict:
        """폴더 + 세션 카탈로그 조회.

        soul-common의 카탈로그(폴더 배정 맵)와 DB 세션 목록을 병합하여
        orchestrator-dashboard가 기대하는 배열 형식으로 반환한다.
        """
        # 폴더 + 세션→폴더 배정 맵
        catalog = await catalog_service.get_catalog()
        folder_assignments = catalog.get("sessions", {})

        # DB에서 전체 세션 목록 조회
        sessions_raw, total = await db.get_all_sessions(offset=0, limit=2000)

        # sessions dict: soul-ui CatalogState 호환 (Record<string, CatalogAssignment>)
        sessions_dict = {}
        for s in sessions_raw:
            sid = s.get("session_id", "")
            assignment = folder_assignments.get(sid, {})
            sessions_dict[sid] = {
                "folderId": assignment.get("folderId"),
                "displayName": assignment.get("displayName"),
            }

        # sessionList 배열: OrchestratorSessionProvider가 세션 목록 구성에 사용
        session_list = []
        for s in sessions_raw:
            sid = s.get("session_id", "")
            assignment = folder_assignments.get(sid, {})
            session_list.append({
                "session_id": sid,
                "node_id": s.get("node_id", ""),
                "folder_id": assignment.get("folderId"),
                "display_name": assignment.get("displayName"),
                "last_message": s.get("last_message"),  # JSONB dict or None
                "status": s.get("status", "unknown"),
                "session_type": s.get("session_type", "claude"),
                "created_at": s.get("created_at", ""),
                "updated_at": s.get("updated_at"),
                "last_event_id": s.get("last_event_id", 0),
                "last_read_event_id": s.get("last_read_event_id", 0),
            })

        return {
            "folders": catalog.get("folders", []),
            "sessions": sessions_dict,
            "sessionList": session_list,
        }

    return router
