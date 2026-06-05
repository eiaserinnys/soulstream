"""세션 상태 갱신 PUT/PATCH 엔드포인트 — 읽음 위치, 표시 이름."""

import logging

from fastapi import APIRouter, Depends, HTTPException

from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.service.task_manager import get_task_manager

from ._models import ReadPositionBody, RenameSessionRequest

logger = logging.getLogger(__name__)

router = APIRouter()


# === /api/sessions/{id}/read-position (PUT) ===

@router.put(
    "/api/sessions/{session_id}/read-position",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_update_read_position(
    session_id: str,
    body: ReadPositionBody,
):
    """읽음 위치 갱신 (PUT /api/sessions/{id}/read-position)"""
    from soul_server.service.postgres_session_db import get_session_db
    db = get_session_db()

    success = await db.update_last_read_event_id(session_id, body.last_read_event_id)
    if not success:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": f"세션을 찾을 수 없습니다: {session_id}",
                    "details": {},
                }
            },
        )

    # Task 객체도 갱신 (이중 저장소 정합성 유지)
    try:
        task_manager = get_task_manager()
        task = await task_manager.get_task(session_id)
        if task:
            task.last_read_event_id = body.last_read_event_id
    except KeyError:
        pass  # 퇴거된 세션은 Task가 없을 수 있음
    except RuntimeError:
        logger.warning(f"TaskManager not available when syncing read position for {session_id}")

    # SSE 브로드캐스트
    last_event_id, last_read_event_id = await db.get_read_position(session_id)
    try:
        session_broadcaster = get_session_broadcaster()
        await session_broadcaster.emit_read_position_updated(
            session_id=session_id,
            last_event_id=last_event_id,
            last_read_event_id=last_read_event_id,
        )
    except Exception:
        logger.warning(
            f"Failed to broadcast read-position update for {session_id}",
            exc_info=True,
        )

    return {"ok": True}


# === /api/sessions/{id}/display-name (PATCH) ===

@router.patch(
    "/api/sessions/{session_id}/display-name",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_rename_session(session_id: str, body: RenameSessionRequest):
    """세션 표시 이름 변경 (PATCH /api/sessions/{id}/display-name).

    soulstream-server 호환 경로. soul-server에서도 동일하게 동작하도록 추가.
    기존 catalog session 표시명 경로와 동일한 동작을 제공한다.
    """
    from soul_server.service.catalog_service import get_catalog_service
    catalog_service = get_catalog_service()
    await catalog_service.rename_session(session_id, body.displayName)
    return {"success": True}
