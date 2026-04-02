"""
Catalog API 라우터 — /api/catalog

폴더 + 세션 통합 카탈로그 조회.

응답 형식:
- folders: [{id, name, sortOrder}]
- sessions: Record<string, {folderId, displayName}>  — soul-ui CatalogState 호환
- sessionList: [{session_id, node_id, folder_id, display_name, last_message, status,
                 created_at, updated_at, prompt, agent_id, agentName, agentPortraitUrl}]

soul-common의 CatalogService.get_catalog()은 sessions를 dict(세션ID → 폴더배정)으로
반환하므로, 오케스트레이터에서는 DB 세션 목록과 폴더 배정을 병합하여 두 가지 형식으로 제공한다.
- sessions dict: soul-ui의 useSessionListProvider가 setCatalog(data)로 사용
- sessionList 배열: OrchestratorSessionProvider가 세션 목록 구성에 사용
"""

import logging
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from soul_common.catalog.catalog_service import CatalogService
from soul_common.db.session_db import PostgresSessionDB
from soulstream_server.api.sessions import _build_portrait_proxy_url, _build_user_portrait_proxy_url
from soulstream_server.models import BatchMoveRequest
from soulstream_server.nodes.node_manager import NodeManager

logger = logging.getLogger(__name__)


class SessionCatalogUpdate(BaseModel):
    folderId: Optional[str] = None
    displayName: Optional[str] = None


def create_catalog_router(
    catalog_service: CatalogService,
    db: PostgresSessionDB,
    node_manager: NodeManager,
) -> APIRouter:
    router = APIRouter(prefix="/api/catalog", tags=["catalog"])

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

        # sessionList 배열: OrchestratorSessionProvider가 세션 목록 구성에 사용
        session_list = []
        for s in sessions_raw:
            sid = s.get("session_id", "")
            assignment = folder_assignments.get(sid, {})

            # agent 정보 조회 (크로스-노드 fallback 포함)
            agent_id = s.get("agent_id")
            node_id = s.get("node_id", "")
            agentName = None
            agentPortraitUrl = None
            if agent_id:
                found = node_manager.find_agent_profile(
                    agent_id, preferred_node_id=node_id
                )
                if found:
                    profile, source_node_id = found
                    agentName = profile.get("name")
                    if profile.get("portrait_url") and source_node_id:
                        agentPortraitUrl = _build_portrait_proxy_url(
                            source_node_id, agent_id
                        )

            # 사용자 정보 조회
            userName = None
            userPortraitUrl = None
            if node_id:
                user_info = node_manager.get_user_info(node_id)
                if user_info:
                    userName = user_info.get("name")
                    if user_info.get("hasPortrait"):
                        userPortraitUrl = _build_user_portrait_proxy_url(node_id)

            session_list.append({
                "session_id": sid,
                "node_id": node_id,
                "folder_id": assignment.get("folderId"),
                "display_name": assignment.get("displayName"),
                "last_message": s.get("last_message"),  # JSONB dict or None
                "status": s.get("status", "unknown"),
                "session_type": s.get("session_type", "claude"),
                "created_at": s.get("created_at", ""),
                "updated_at": s.get("updated_at"),
                "last_event_id": s.get("last_event_id", 0),
                "last_read_event_id": s.get("last_read_event_id", 0),
                # 에이전트 및 사용자 메시지 정보
                "prompt": s.get("prompt"),
                "agent_id": agent_id,
                "agentName": agentName,
                "agentPortraitUrl": agentPortraitUrl,
                "userName": userName,
                "userPortraitUrl": userPortraitUrl,
            })

        return {
            "folders": catalog.get("folders", []),
            "sessions": sessions_dict,
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
