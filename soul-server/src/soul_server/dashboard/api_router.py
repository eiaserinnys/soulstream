"""
Dashboard API Router - /api/* 엔드포인트

soul-dashboard(TypeScript BFF)가 제공하던 /api/ 경로를 soul-server에 직접 내장합니다.
브라우저는 soul-server(포트 4105)에 직접 접근하고,
봇의 기존 Bearer Token 접근 방식(SEOSOYOUNG_SOUL_URL → 4105)은 변경하지 않습니다.

엔드포인트 등록 순서 (중요):
- GET /api/sessions/stream은 GET /api/sessions/{session_id}/events보다 먼저 등록.
  그렇지 않으면 /api/sessions/stream이 {session_id}="stream"으로 매칭됨.
"""

import asyncio
import json
import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from soul_server.api.sessions import stream_session_events
from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.dashboard.session_cache import SessionCache
from soul_server.service.task_manager import (
    get_task_manager,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
)
from soul_server.service import resource_manager, get_soul_engine
from soul_server.service.session_broadcaster import get_session_broadcaster

logger = logging.getLogger(__name__)

router = APIRouter()


# === 의존성 주입 ===

async def get_session_cache(request: Request) -> SessionCache:
    return request.app.state.session_cache


# === 요청 모델 ===

class CreateSessionBody(BaseModel):
    prompt: str
    agentSessionId: Optional[str] = None
    use_mcp: bool = True


class InterveneBody(BaseModel):
    text: str
    user: str
    attachmentPaths: Optional[list] = None


class RespondBody(BaseModel):
    requestId: str
    answers: dict


# === /api/health ===

@router.get("/api/health")
async def api_health():
    return {"status": "ok"}


# === /api/config ===

@router.get("/api/config")
async def api_config():
    serendipity_url = os.environ.get("SERENDIPITY_URL", "")
    return {"serendipityAvailable": bool(serendipity_url)}


# === /api/status ===

@router.get("/api/status", dependencies=[Depends(require_dashboard_auth)])
async def api_status(request: Request):
    task_manager = get_task_manager()
    running_tasks = task_manager.get_running_tasks()

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
async def api_get_sessions():
    task_manager = get_task_manager()
    sessions, total = task_manager.get_all_sessions(
        offset=0, limit=0, session_type=None
    )
    return {"sessions": sessions, "total": total}


# === /api/sessions/stream (GET) — 고정 경로, 반드시 먼저 등록 ===

@router.get("/api/sessions/stream", dependencies=[Depends(require_dashboard_auth)])
async def api_sessions_stream():
    """세션 목록 변경 SSE 스트림 (GET /api/sessions/stream)"""

    async def event_generator():
        task_manager = get_task_manager()
        session_broadcaster = get_session_broadcaster()

        sessions, total = task_manager.get_all_sessions()
        yield {
            "event": "session_list",
            "data": json.dumps(
                {"type": "session_list", "sessions": sessions, "total": total},
                ensure_ascii=False,
            ),
        }

        event_queue: asyncio.Queue = asyncio.Queue()
        await session_broadcaster.add_listener(event_queue)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=30.0)
                    yield {
                        "event": event.get("type", "unknown"),
                        "data": json.dumps(event, ensure_ascii=False),
                    }
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        finally:
            await session_broadcaster.remove_listener(event_queue)

    from sse_starlette.sse import EventSourceResponse
    return EventSourceResponse(event_generator())


# === /api/sessions/{session_id}/events (GET) — 파라미터화 경로, 나중에 등록 ===

@router.get(
    "/api/sessions/{session_id}/events",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_session_events_cached(
    session_id: str,
    request: Request,
    session_cache: SessionCache = Depends(get_session_cache),
):
    """SessionCache 통합 SSE 스트림 (GET /api/sessions/{id}/events)"""
    task_manager = get_task_manager()

    last_event_id_str = request.headers.get("Last-Event-ID")
    after_id: Optional[int] = int(last_event_id_str) if last_event_id_str else None

    cached_events = await session_cache.read_events(session_id, after_id)

    async def event_generator():
        # next_id 초기값: 명시적 None 체크 (after_id=0 시 0이 falsy라 오동작 방지)
        next_id = (
            cached_events[-1]["id"]
            if cached_events
            else (after_id if after_id is not None else 0)
        )

        # 1. 캐시에서 히스토리 재전송
        for item in cached_events:
            event_type = item["event"].get("type", "unknown") if isinstance(item["event"], dict) else "unknown"
            yield (
                f"id: {item['id']}\n"
                f"event: {event_type}\n"
                f"data: {json.dumps(item['event'], ensure_ascii=False)}\n\n"
            )

        # 2. history_sync + 라이브 이벤트 스트리밍
        async for event_dict in stream_session_events(
            session_id, last_stored_id=next_id, task_manager=task_manager
        ):
            event_type = event_dict.get("type", "unknown")
            if event_type == "keepalive":
                yield ": keepalive\n\n"
            elif event_type == "history_sync":
                # history_sync는 캐시에 저장하지 않음 (메타데이터 이벤트)
                yield (
                    f"event: history_sync\n"
                    f"data: {json.dumps(event_dict, ensure_ascii=False)}\n\n"
                )
            else:
                next_id += 1
                await session_cache.append_event(session_id, next_id, event_dict)
                yield (
                    f"id: {next_id}\n"
                    f"event: {event_type}\n"
                    f"data: {json.dumps(event_dict, ensure_ascii=False)}\n\n"
                )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


# === /api/sessions (POST) ===

@router.post("/api/sessions", status_code=201, dependencies=[Depends(require_dashboard_auth)])
async def api_create_session(body: CreateSessionBody):
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

    try:
        task = await task_manager.create_task(
            prompt=body.prompt,
            agent_session_id=body.agentSessionId,
            use_mcp=body.use_mcp,
        )
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

    await task_manager.start_execution(
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
async def api_intervene(session_id: str, body: InterveneBody):
    """실행 중/완료된 세션에 메시지 전송 (자동 resume)"""
    task_manager = get_task_manager()

    try:
        result = await task_manager.add_intervention(
            agent_session_id=session_id,
            text=body.text,
            user=body.user,
            attachment_paths=body.attachmentPaths or [],
        )

        if result.get("auto_resumed"):
            await task_manager.start_execution(
                agent_session_id=session_id,
                claude_runner=get_soul_engine(),
                resource_manager=resource_manager,
            )
            return {"auto_resumed": True, "agent_session_id": session_id}
        else:
            return {"queued": True, "queue_position": result.get("queue_position", 0)}

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
async def api_message(session_id: str, body: InterveneBody):
    """intervene의 레거시 호환 경로"""
    return await api_intervene(session_id, body)


# === /api/sessions/{id}/respond (POST) ===

@router.post(
    "/api/sessions/{session_id}/respond",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_respond(session_id: str, body: RespondBody):
    """AskUserQuestion에 대한 사용자 응답 전달"""
    task_manager = get_task_manager()

    try:
        success = task_manager.deliver_input_response(
            agent_session_id=session_id,
            request_id=body.requestId,
            answers=body.answers,
        )

        if success:
            return {"delivered": True, "request_id": body.requestId}
        else:
            raise HTTPException(
                status_code=422,
                detail={
                    "error": {
                        "code": "REQUEST_NOT_PENDING",
                        "message": f"대기 중인 input_request가 없습니다: {body.requestId}",
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


# === /api/llm/completions (POST) ===

@router.post(
    "/api/llm/completions",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_llm_completions(request: Request):
    """LLM completions 프록시 (soul-server 내장 LLM executor 경유)"""
    llm_executor = getattr(request.app.state, "llm_executor", None)
    if llm_executor is None:
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "LLM_NOT_CONFIGURED",
                    "message": "LLM executor가 초기화되지 않았습니다. LLM API 키를 설정하세요.",
                }
            },
        )

    from soul_server.models.llm import LlmCompletionRequest

    body = await request.json()
    try:
        llm_request = LlmCompletionRequest(**body)
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "INVALID_REQUEST", "message": str(e)}},
        )

    try:
        result = await llm_executor.execute(llm_request)
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "PROVIDER_NOT_CONFIGURED", "message": str(e)}},
        )
    except Exception as e:
        logger.exception(f"LLM completion error: {e}")
        raise HTTPException(
            status_code=502,
            detail={"error": {"code": "LLM_API_ERROR", "message": "LLM API call failed"}},
        )
