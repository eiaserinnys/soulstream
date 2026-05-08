"""세션 라이프사이클 POST 엔드포인트 — 생성, 인터벤션, 응답."""

from fastapi import APIRouter, Depends, HTTPException, Request

from soul_common.auth.caller_info import build_browser_caller_info
from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.service import get_soul_engine, intervention_service, resource_manager
from soul_server.service.intervention_service import InputRequestNotPendingError
from soul_server.service.task_factory import CreateTaskParams
from soul_server.service.task_manager import (
    NodeMismatchError,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    get_task_manager,
)
from soul_server.util.attachment_helpers import build_attachment_context_items

from ._models import CreateSessionBody, InterveneBody, RespondBody

router = APIRouter()


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
