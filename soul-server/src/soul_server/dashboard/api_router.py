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
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from soul_server.api.sessions import stream_session_events
from soul_server.dashboard.auth import require_dashboard_auth
from soul_server.service.task_manager import (
    get_task_manager,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    NodeMismatchError,
)
from soul_server.service import resource_manager, get_soul_engine
from soul_server.service.session_broadcaster import get_session_broadcaster

logger = logging.getLogger(__name__)

router = APIRouter()


# === 요청 모델 ===

class CreateSessionBody(BaseModel):
    prompt: str
    agentSessionId: Optional[str] = None
    folderId: Optional[str] = None
    agentId: Optional[str] = None  # 에이전트 프로필 ID (AgentRegistry 조회 키)
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


# === /api/config/settings ===

@router.get(
    "/api/config/settings",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_config_settings_get():
    """설정 조회 — 카테고리별 그룹핑 + 메타데이터"""
    from soul_server.config import (
        get_settings, SETTINGS_REGISTRY, CATEGORY_LABELS,
    )
    from dataclasses import fields as dataclass_fields

    settings = get_settings()

    # 카테고리별 필드 그룹핑
    categories_map: dict[str, list] = {}
    for field_name, meta in SETTINGS_REGISTRY.items():
        value = getattr(settings, field_name, None)
        # csv 타입은 리스트 → 쉼표 구분 문자열로 변환
        if meta.value_type == "csv" and isinstance(value, list):
            value = ",".join(value)
        # sensitive 필드 마스킹
        if meta.sensitive and value and str(value).strip():
            display_value = "********"
        else:
            display_value = value

        field_data = {
            "key": meta.env_key,
            "field_name": field_name,
            "label": meta.label,
            "description": meta.description,
            "value": display_value,
            "value_type": meta.value_type,
            "sensitive": meta.sensitive,
            "hot_reloadable": meta.hot_reloadable,
            "read_only": meta.read_only,
        }

        if meta.category not in categories_map:
            categories_map[meta.category] = []
        categories_map[meta.category].append(field_data)

    # 카테고리 순서 유지 (CATEGORY_LABELS 순서)
    categories = [
        {"name": cat, "label": CATEGORY_LABELS.get(cat, cat), "fields": categories_map[cat]}
        for cat in CATEGORY_LABELS
        if cat in categories_map
    ]

    return {
        "serendipityAvailable": bool(settings.serendipity_url),
        "categories": categories,
    }


class ConfigSettingsUpdateBody(BaseModel):
    changes: dict[str, str]


@router.put(
    "/api/config/settings",
    dependencies=[Depends(require_dashboard_auth)],
)
async def api_config_settings_put(body: ConfigSettingsUpdateBody):
    """설정 업데이트 — .env 쓰기 + 핫리로드"""
    from pathlib import Path
    from dotenv import load_dotenv, set_key
    from soul_server.config import (
        get_settings, SETTINGS_REGISTRY,
    )

    dotenv_path = str(Path.cwd() / ".env")
    applied: list[str] = []
    restart_required: list[str] = []
    errors: list[str] = []

    # env_key → field_name 역매핑
    env_key_to_field: dict[str, str] = {
        meta.env_key: field_name
        for field_name, meta in SETTINGS_REGISTRY.items()
    }

    for env_key, new_value in body.changes.items():
        field_name = env_key_to_field.get(env_key)
        if field_name is None:
            errors.append(f"Unknown setting: {env_key}")
            continue

        meta = SETTINGS_REGISTRY[field_name]
        if meta.read_only:
            errors.append(f"Read-only setting: {env_key}")
            continue

        # .env 파일에 기록
        try:
            set_key(dotenv_path, env_key, new_value)
        except Exception as e:
            errors.append(f"Failed to write {env_key}: {e}")
            continue

        if meta.hot_reloadable:
            applied.append(env_key)
        else:
            restart_required.append(env_key)

    if errors and not applied and not restart_required:
        raise HTTPException(status_code=400, detail={"errors": errors})

    # .env 리로드 + Settings 캐시 무효화
    load_dotenv(dotenv_path=dotenv_path, override=True)
    get_settings.cache_clear()

    return {
        "applied": applied,
        "restart_required": restart_required,
        "errors": errors,
    }


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
async def api_get_sessions(
    session_type: Optional[str] = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=0),
):
    task_manager = get_task_manager()
    sessions, total = await task_manager.get_all_sessions(
        offset=offset, limit=limit, session_type=session_type
    )
    return {"sessions": sessions, "total": total}


# === /api/sessions/folder-counts (GET) — 고정 경로, 반드시 stream/events보다 먼저 등록 ===

@router.get("/api/sessions/folder-counts", dependencies=[Depends(require_dashboard_auth)])
async def api_session_folder_counts():
    """폴더별 세션 수 조회 (GET /api/sessions/folder-counts)"""
    from soul_server.config import get_settings
    from soul_server.service.postgres_session_db import get_session_db
    node_id = get_settings().soulstream_node_id or None
    db = get_session_db()
    counts = await db.get_folder_counts(node_id=node_id)
    # None 키(폴더 미지정)는 JSON 직렬화 시 "null" 문자열로 변환
    return {"counts": {str(k) if k is not None else "null": v for k, v in counts.items()}}


# === /api/sessions/stream (GET) — 고정 경로, 반드시 먼저 등록 ===

@router.get("/api/sessions/stream", dependencies=[Depends(require_dashboard_auth)])
async def api_sessions_stream(limit: int = Query(50, ge=0)):
    """세션 목록 변경 SSE 스트림 (GET /api/sessions/stream)"""

    async def event_generator():
        task_manager = get_task_manager()
        session_broadcaster = get_session_broadcaster()

        sessions, total = await task_manager.get_all_sessions(offset=0, limit=limit)
        yield {
            "event": "session_list",
            "data": json.dumps(
                {"type": "session_list", "sessions": sessions, "total": total},
                ensure_ascii=False,
                default=str,
            ),
        }

        event_queue = session_broadcaster.add_client()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=30.0)
                    yield {
                        "event": event.get("type", "unknown"),
                        "data": json.dumps(event, ensure_ascii=False, default=str),
                    }
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        finally:
            session_broadcaster.remove_client(event_queue)

    from sse_starlette.sse import EventSourceResponse
    return EventSourceResponse(event_generator())


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

    EventStore에서 히스토리를 읽고, 이후 라이브 이벤트를 스트리밍한다.
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

    async def event_generator():
        # 리스너를 히스토리 읽기 전에 등록하여
        # DB 읽기와 리스너 등록 사이의 경합으로 이벤트가 누락되는 것을 방지한다.
        event_queue = asyncio.Queue()
        await task_manager.add_listener(session_id, event_queue)
        entered_stream = False

        try:
            # Part 1: SessionDB에서 히스토리 스트리밍
            from soul_server.service.postgres_session_db import get_session_db
            db = get_session_db()
            last_stored_id = 0

            try:
                async for event_id, event_type, payload_text in db.stream_events_raw(
                    session_id, after_id=after_id,
                ):
                    last_stored_id = max(last_stored_id, event_id)
                    # payload_text는 PostgreSQL jsonb::text 캐스트 결과로,
                    # compact JSON(개행 없음)이 보장되어 SSE data: 필드에 안전하다.
                    yield (
                        f"id: {event_id}\n"
                        f"event: {event_type}\n"
                        f"data: {payload_text}\n\n"
                    )
            except Exception as e:
                logger.error("Failed to read events for %s: %s", session_id, e)

            if is_llm:
                # LLM 세션은 단발 요청이라 라이브 이벤트가 없다.
                # history_sync만 보내고 스트림을 종료한다.
                sync_payload = {
                    "type": "history_sync",
                    "last_event_id": last_stored_id,
                    "is_live": False,
                    "status": "completed",
                }
                yield (
                    f"event: history_sync\n"
                    f"data: {json.dumps(sync_payload, ensure_ascii=False, default=str)}\n\n"
                )
                return

            # Part 2+3: history_sync + 라이브 이벤트 스트리밍 (Claude 세션)
            # stream_session_events의 finally에서 remove_listener를 호출한다.
            entered_stream = True
            async for event_dict in stream_session_events(
                session_id, last_stored_id=last_stored_id, task_manager=task_manager,
                event_queue=event_queue,
            ):
                event_type = event_dict.get("type", "unknown")
                if event_type == "keepalive":
                    yield ": keepalive\n\n"
                elif event_type == "history_sync":
                    yield (
                        f"event: history_sync\n"
                        f"data: {json.dumps(event_dict, ensure_ascii=False, default=str)}\n\n"
                    )
                else:
                    # _event_id를 pop하여 data JSON에서 제거하되, SSE id: 필드로 전달
                    event_id = event_dict.pop("_event_id", None)
                    sse_id = f"id: {event_id}\n" if event_id is not None else ""
                    yield (
                        f"{sse_id}"
                        f"event: {event_type}\n"
                        f"data: {json.dumps(event_dict, ensure_ascii=False, default=str)}\n\n"
                    )
        finally:
            if not entered_stream:
                # stream_session_events에 진입하지 못했으면 직접 정리
                # (LLM 세션 조기 return, 히스토리 읽기 중 연결 해제 등)
                await task_manager.remove_listener(session_id, event_queue)

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
            folder_id=body.folderId,
            profile_id=body.agentId,
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
    except NodeMismatchError as e:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "node_mismatch",
                "session_node_id": e.session_node_id,
                "current_node_id": e.current_node_id,
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


# === /api/sessions/{id}/read-position (PUT) ===

class ReadPositionBody(BaseModel):
    last_read_event_id: int


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
