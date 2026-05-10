"""세션 조회 GET 엔드포인트.

엔드포인트 등록 순서 (중요):
- GET /api/sessions/stream, /api/sessions/folder-counts는
  GET /api/sessions/{session_id}/events보다 먼저 등록해야 한다.
  그렇지 않으면 고정 경로가 {session_id} path parameter로 매칭됨.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sse_starlette.sse import EventSourceResponse

from soul_server.api.sessions import session_events_sse_generator
from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.dashboard.user_profile import apply_dash_user_profile_enrichment
from soul_server.service.session_query_service import (
    InvalidViewportRangeError,
    get_session_query_service,
)
from soul_server.service.task_manager import get_task_manager

router = APIRouter()


# === /api/sessions (GET) ===

@router.get("/api/sessions", dependencies=[Depends(require_dashboard_auth)])
async def api_get_sessions(
    session_type: Optional[str] = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=0),
    folder_id: Optional[str] = None,
    feed_only: bool = Query(False),
):
    from soul_server.config import get_settings
    task_manager = get_task_manager()
    sessions, total = await get_session_query_service().get_all_sessions(
        offset=offset, limit=limit, session_type=session_type,
        folder_id=folder_id,  # None이면 전체 조회 (기존 동작 유지)
        feed_only=feed_only,
    )
    # R-3 fix(2026-05-08): caller_info 정체성 우선, settings dash_user로 fallback.
    # 기존 코드는 모든 행에 settings.dash_user_name을 일괄 덮어써 caller_info(슬랙·위임 등)
    # 정체성을 무시했다. 헬퍼가 mix-fallback 금지 정책을 적용하여 정체성 보존.
    # orch `apply_user_profile_enrichment`와 동일 의미 (정본 둘 안티패턴 atom d7a1ad86 회피).
    settings = get_settings()
    user_name = settings.dash_user_name
    user_portrait_url = "/api/dashboard/portrait/user" if settings.dash_user_portrait else None
    sessions_with_user = [dict(s) for s in sessions]
    for entry in sessions_with_user:
        # R-2 fix: entry["caller_source"]는 _build_session_dict이 caller_info에서 promote.
        # 정체성 명시 source(agent/system/slack/soul-app)면 헬퍼가 즉시 NOOP하여
        # settings.dash_user_*로 덮지 않는다 (atom 0499ee7b §9 대칭).
        apply_dash_user_profile_enrichment(
            entry,
            user_name=user_name,
            user_portrait_url=user_portrait_url,
            caller_source=entry.get("caller_source"),
        )
    return {"sessions": sessions_with_user, "total": total}


# === /api/sessions/folder-counts (GET) — 고정 경로, 반드시 stream/events보다 먼저 등록 ===

@router.get("/api/sessions/folder-counts", dependencies=[Depends(require_dashboard_auth)])
async def api_session_folder_counts():
    """폴더별 세션 수 조회 (GET /api/sessions/folder-counts)"""
    from soul_server.service.postgres_session_db import get_session_db
    db = get_session_db()
    counts = await db.get_folder_counts()  # node_id 필터 제거 → 전체 노드 집계
    # None 키(폴더 미지정)는 JSON 직렬화 시 "null" 문자열로 변환
    return {"counts": {str(k) if k is not None else "null": v for k, v in counts.items()}}


# === /api/sessions/stream (GET) — 고정 경로, 반드시 먼저 등록 ===

@router.get("/api/sessions/stream", dependencies=[Depends(require_dashboard_auth)])
async def api_sessions_stream(limit: int = Query(50, ge=0)):
    """세션 목록 변경 SSE 스트림 (GET /api/sessions/stream).

    `api/sessions.py`의 sessions_stream과 같은 service 메서드를 호출한다 (정본 하나).
    260505.15 dedupe 이전에는 동일한 generator 본체를 두 라우터에 미러링했다.
    """
    return EventSourceResponse(
        get_session_query_service().stream_session_list_events(limit=limit)
    )


# === /api/sessions/{session_id}/events/viewport (GET) — Phase 3 뷰포트 API ===
# 파라미터화 경로(`/events`)가 `/events/viewport`를 prefix-match하지 않도록 먼저 등록한다.

@router.get(
    "/api/sessions/{agent_session_id}/events/viewport",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_session_events_viewport(
    agent_session_id: str,
    y_min: int = Query(..., ge=1, description="가상 Y축 시작 (1-based inclusive)"),
    y_max: int = Query(..., ge=1, description="가상 Y축 끝 (inclusive)"),
):
    """뷰포트 영역과 겹치는 이벤트 조회 (가상화 API, Phase 3).

    `api/sessions.py`의 동명 핸들러와 같은 service 메서드를 호출한다 (정본 하나,
    260505.15 dedupe).
    """
    try:
        return await get_session_query_service().read_viewport(
            agent_session_id, y_min, y_max,
        )
    except InvalidViewportRangeError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_RANGE",
                    "message": str(e),
                    "details": {},
                }
            },
        )


# === /api/sessions/{session_id}/messages (GET) — Phase 3 커서 페이지네이션 ===

@router.get(
    "/api/sessions/{agent_session_id}/messages",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_session_messages(
    agent_session_id: str,
    before: Optional[str] = Query(None, description="커서 (ISO timestamp). 이보다 이전 메시지만 조회"),
    limit: int = Query(50, ge=1, le=200, description="페이지 크기"),
):
    """메시지 페이지네이션 조회 (Phase 3).

    `api/sessions.py`의 동명 핸들러와 같은 service 메서드를 호출한다 (정본 하나,
    260505.15 dedupe).
    """
    return await get_session_query_service().read_messages(
        agent_session_id, before=before, limit=limit,
    )


# === /api/sessions/{session_id}/events (GET) — 파라미터화 경로, 나중에 등록 ===

@router.get(
    "/api/sessions/{session_id}/events",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_session_events(
    session_id: str,
    request: Request,
):
    """EventStore 기반 SSE 스트림 (GET /api/sessions/{id}/events)

    Last-Event-ID(헤더 또는 ?lastEventId 쿼리)의 값을 after_id로 해석한다:
    - after_id == 0 (또는 미전송): 히스토리 skip — baseline은 history_sync로 전달
    - after_id > 0: 그 이후의 이벤트만 리플레이 (재연결 catch-up)

    LLM 세션은 단발 HTTP 요청이라 라이브 이벤트가 없으므로 히스토리 전송 후 종료한다.
    SessionCache는 사용하지 않는다.
    """
    task_manager = get_task_manager()

    last_event_id_str = request.headers.get("Last-Event-ID") or request.query_params.get("lastEventId")
    try:
        after_id = int(last_event_id_str) if last_event_id_str else 0
    except (ValueError, TypeError):
        after_id = 0

    # LLM 세션 여부 판단: task 조회 우선, 없으면 session_id 패턴으로 fallback
    task = await task_manager.get_task(session_id)
    is_llm = (task is not None and task.session_type == "llm") or session_id.startswith("llm-")

    return EventSourceResponse(
        session_events_sse_generator(
            session_id, after_id, task_manager,
            is_llm=is_llm,
        )
    )
