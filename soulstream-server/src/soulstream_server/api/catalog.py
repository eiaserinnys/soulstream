"""
Catalog API 라우터 — /api/catalog

폴더 + 세션 통합 카탈로그 조회.

orchestrator-dashboard 프론트엔드가 기대하는 형식:
- folders: [{id, name, sortOrder}]
- sessions: [{session_id, node_id, folder_id, status, created_at, updated_at}]

soul-common의 CatalogService.get_catalog()은 sessions를 dict(세션ID → 폴더배정)으로
반환하므로, 오케스트레이터에서는 DB 세션 목록과 폴더 배정을 병합하여 클라이언트가
기대하는 배열 형식으로 변환한다.
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

        # 프론트엔드가 기대하는 배열 형식으로 병합
        sessions = []
        for s in sessions_raw:
            sid = s.get("agent_session_id", "")
            assignment = folder_assignments.get(sid, {})
            sessions.append({
                "session_id": sid,
                "node_id": s.get("node_id", ""),
                "folder_id": assignment.get("folderId"),
                "display_name": assignment.get("displayName"),
                "status": s.get("status", "unknown"),
                "created_at": s.get("created_at", ""),
                "updated_at": s.get("updated_at"),
            })

        return {
            "folders": catalog.get("folders", []),
            "sessions": sessions,
        }

    return router
