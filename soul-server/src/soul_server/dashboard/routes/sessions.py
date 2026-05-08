"""세션 라이프사이클 + SSE 라우터 (/api/sessions/*, /api/status)

엔드포인트 등록 순서 (중요):
- GET /api/sessions/stream, /api/sessions/folder-counts는
  GET /api/sessions/{session_id}/events보다 먼저 등록해야 한다.
  그렇지 않으면 고정 경로가 {session_id} path parameter로 매칭됨.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import AliasChoices, BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from soul_common.auth.caller_info import build_browser_caller_info
from soul_server.api.sessions import session_events_sse_generator
from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.service.task_manager import (
    get_task_manager,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    NodeMismatchError,
)
from soul_server.service.task_factory import CreateTaskParams
from soul_server.service.session_query_service import (
    InvalidViewportRangeError,
    get_session_query_service,
)
from soul_server.service import resource_manager, get_soul_engine
from soul_server.service import intervention_service
from soul_server.service.intervention_service import InputRequestNotPendingError
from soul_server.service.session_broadcaster import get_session_broadcaster
from soul_server.util.attachment_helpers import build_attachment_context_items

logger = logging.getLogger(__name__)

router = APIRouter()


# === 요청 모델 ===

class CreateSessionBody(BaseModel):
    # 'agentId'와 'profile' 양쪽을 모두 수용한다.
    # - soul-server 고유 용어: agentId (AgentRegistry 조회 키)
    # - orch-server / cron 공용 용어: profile (동일 값의 다른 이름)
    # 두 서버 API를 대칭으로 유지하여 호출자가 용어를 바꾸지 않아도 동작하게 한다.
    model_config = ConfigDict(populate_by_name=True)

    prompt: str
    agentSessionId: Optional[str] = None
    folderId: Optional[str] = None
    agentId: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("agentId", "profile"),
    )
    use_mcp: bool = True
    attachmentPaths: Optional[list[str]] = None  # 세션 시작 전 업로드된 파일 절대 경로 목록
    caller_session_id: Optional[str] = None  # 발신 세션 ID (완료 시 자동 보고 대상)
    caller_info: Optional[dict] = None  # 발신자 정보. 비어있으면 서버가 HTTP Request에서 조립한다.


class InterveneBody(BaseModel):
    text: str
    user: str
    attachmentPaths: Optional[list] = None
    caller_info: Optional[dict] = None  # 발신자 정보(통합 v1). 비어있으면 라우트가 build_browser_caller_info로 자동 조립.


class RespondBody(BaseModel):
    # snake_case(슬랙봇 등 외부 클라이언트)와 camelCase(대시보드)를 모두 수용한다.
    # Field(alias=...)는 alias→필드 방향, populate_by_name=True는 필드명→필드 방향을
    # 추가로 연다. AliasChoices는 alias가 여러 개일 때 사용하므로 여기서는 불필요.
    # 동일 패턴: orch-server RespondRequest (api/sessions.py:65).
    model_config = ConfigDict(populate_by_name=True)
    request_id: str = Field(alias="requestId")
    answers: dict


class ReadPositionBody(BaseModel):
    last_read_event_id: int


class RenameSessionRequest(BaseModel):
    displayName: Optional[str] = None


# === /api/status ===

@router.get("/api/status", dependencies=[Depends(require_dashboard_auth)])
async def api_status(request: Request):
    task_manager = get_task_manager()
    running_tasks = get_session_query_service().get_running_tasks()

    response: dict = {
        "active_tasks": len(running_tasks),
        "max_concurrent": resource_manager.max_concurrent,
        "is_draining": getattr(request.app.state, "is_draining", False),
        "tasks": [
            {
                "client_id": t.client_id,
                "agent_session_id": t.agent_session_id,
                "status": t.status,
                "created_at": t.created_at.isoformat(),
            }
            for t in running_tasks
        ],
    }

    runner_pool = getattr(request.app.state, "runner_pool", None)
    if runner_pool is not None:
        response["runner_pool"] = runner_pool.stats()

    return response


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
    settings = get_settings()
    user_name = settings.dash_user_name
    user_portrait_url = "/api/dashboard/portrait/user" if settings.dash_user_portrait else None
    sessions_with_user = [
        {**s, "userName": user_name, "userPortraitUrl": user_portrait_url}
        for s in sessions
    ]
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


# === /api/sessions (POST) ===

@router.post("/api/sessions", status_code=201, dependencies=[Depends(require_dashboard_auth)])
async def api_create_session(body: CreateSessionBody, request: Request):
    """새 Claude Code 세션을 시작합니다."""
    task_manager = get_task_manager()

    if not resource_manager.can_acquire():
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "RATE_LIMIT_EXCEEDED",
                    "message": f"동시 실행 제한 초과 (max={resource_manager.max_concurrent})",
                }
            },
        )

    extra_context_items = build_attachment_context_items(body.attachmentPaths)

    # caller_info 조립: body에 있으면 그대로 (슬랙·RN·위임 케이스).
    # 없으면 build_browser_caller_info가 HTTP 메타 + cookie JWT(있으면)를
    # 조립하여 source='browser' caller_info 반환 (방안 B, 2026-05-07).
    from soul_server.config import get_settings
    settings = get_settings()
    caller_info = body.caller_info or build_browser_caller_info(
        request, settings.jwt_secret or ""
    )

    try:
        task = await task_manager.create_task(CreateTaskParams(
            prompt=body.prompt,
            agent_session_id=body.agentSessionId,
            use_mcp=body.use_mcp,
            folder_id=body.folderId,
            profile_id=body.agentId,
            extra_context_items=extra_context_items,
            caller_session_id=body.caller_session_id,
            caller_info=caller_info,
            attachment_paths=body.attachmentPaths,
        ))
    except TaskConflictError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "SESSION_CONFLICT",
                    "message": f"이미 실행 중인 세션입니다: {body.agentSessionId}",
                }
            },
        )
    except NodeMismatchError as e:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "node_mismatch",
                "session_node_id": e.session_node_id,
                "current_node_id": e.current_node_id,
            },
        )

    await task_manager.executor.start_execution(
        agent_session_id=task.agent_session_id,
        claude_runner=get_soul_engine(),
        resource_manager=resource_manager,
    )

    return {"agentSessionId": task.agent_session_id, "status": "running"}


# === /api/sessions/{id}/intervene (POST) ===

@router.post(
    "/api/sessions/{session_id}/intervene",
    status_code=202,
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_intervene(session_id: str, body: InterveneBody, request: Request):
    """실행 중/완료된 세션에 메시지 전송 (자동 resume).

    F-9 fix(2026-05-08): caller_info를 wire에 운반한다. body.caller_info가
    있으면 그대로(슬랙봇 등 외부 클라이언트), 없으면 cookie JWT + HTTP 메타로
    자동 조립(브라우저 dashboard 흐름). create_session 라우트와 동일 패턴.
    """
    try:
        # body.attachmentPaths(camelCase) → attachment_paths(snake_case): 라우트 책임.
        # None → [] 정규화는 service의 정본(`or []`)에 일임 (대칭성).
        from soul_server.config import get_settings
        settings = get_settings()
        caller_info = body.caller_info or build_browser_caller_info(
            request, settings.jwt_secret or "",
        )
        return await intervention_service.intervene(
            agent_session_id=session_id,
            text=body.text,
            user=body.user,
            attachment_paths=body.attachmentPaths,
            task_manager=get_task_manager(),
            soul_engine=get_soul_engine(),
            resource_manager=resource_manager,
            caller_info=caller_info,
        )
    except NodeMismatchError as e:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "node_mismatch",
                "session_node_id": e.session_node_id,
                "current_node_id": e.current_node_id,
            },
        )
    except TaskNotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": f"세션을 찾을 수 없습니다: {session_id}",
                }
            },
        )


# === /api/sessions/{id}/message (POST, 레거시 호환) ===

@router.post(
    "/api/sessions/{session_id}/message",
    status_code=202,
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_message(session_id: str, body: InterveneBody, request: Request):
    """intervene의 레거시 호환 경로"""
    return await api_intervene(session_id, body, request)


# === /api/sessions/{id}/respond (POST) ===

@router.post(
    "/api/sessions/{session_id}/respond",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_respond(session_id: str, body: RespondBody):
    """AskUserQuestion에 대한 사용자 응답 전달"""
    try:
        return await intervention_service.respond_to_input(
            agent_session_id=session_id,
            request_id=body.request_id,
            answers=body.answers,
            task_manager=get_task_manager(),
        )
    except InputRequestNotPendingError as e:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "REQUEST_NOT_PENDING",
                    "message": f"대기 중인 input_request가 없습니다: {e.request_id}",
                }
            },
        )
    except TaskNotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": f"세션을 찾을 수 없습니다: {session_id}",
                }
            },
        )
    except TaskNotRunningError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "SESSION_NOT_RUNNING",
                    "message": f"세션이 실행 중이 아닙니다: {session_id}",
                }
            },
        )


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
    기존 PUT /api/catalog/sessions/{id} (displayName 필드)는 그대로 유지한다.
    """
    from soul_server.service.catalog_service import get_catalog_service
    catalog_service = get_catalog_service()
    await catalog_service.rename_session(session_id, body.displayName)
    return {"success": True}
