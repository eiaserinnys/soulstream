"""
Session API - 세션 기반 API 엔드포인트

agent_session_id를 기본 식별자로 사용하는 per-session 아키텍처.
POST /execute → SSE (첫 이벤트로 agent_session_id 전달)
GET /events/{agent_session_id}/stream → SSE 재연결/재구독
POST /sessions/{agent_session_id}/intervene → 개입 메시지 (자동 resume)
"""

import asyncio
import logging
import json
from typing import Optional
from fastapi import APIRouter, Header, HTTPException, Depends, Request
from sse_starlette.sse import EventSourceResponse

from soul_server.models import (
    ExecuteRequest,
    InputResponseRequest,
    SessionResponse,
    SessionListResponse,
    InterveneRequest,
    ErrorResponse,
)
from soul_server.service.task_manager import (
    get_task_manager,
    Task,
    TaskConflictError,
    TaskNotFoundError,
    TaskNotRunningError,
    NodeMismatchError,
    TaskStatus,
)
from soul_server.service.task_factory import CreateTaskParams
from soul_server.service import resource_manager, get_soul_engine
from soul_server.service.sse_streaming import stream_live_events
from soul_server.service import intervention_service
from soul_server.service.intervention_service import InputRequestNotPendingError
from soul_server.api.auth import verify_token
from soul_server.cogito.reflector_setup import reflect
from soul_server.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter()


def _build_init_event(agent_session_id: str) -> dict:
    """SSE init 이벤트 데이터를 생성한다."""
    data: dict = {
        "type": "init",
        "agent_session_id": agent_session_id,
    }
    node_id = get_settings().soulstream_node_id
    if node_id:
        data["node_id"] = node_id
    return {
        "event": "init",
        "data": json.dumps(data, ensure_ascii=False, default=str),
    }


def task_to_response(task: Task) -> SessionResponse:
    """Task를 SessionResponse로 변환"""
    from soul_server.models import TaskStatus as ResponseTaskStatus
    return SessionResponse(
        agent_session_id=task.agent_session_id,
        status=ResponseTaskStatus(task.status.value),
        result=task.result,
        error=task.error,
        claude_session_id=task.claude_session_id,
        pid=task.pid,
        created_at=task.created_at,
        completed_at=task.completed_at,
    )


@router.post(
    "/execute",
    responses={
        409: {"model": ErrorResponse},
        503: {"model": ErrorResponse},
    },
)
@reflect.capability(
    name="session_management",
    description="Claude Code 세션 생성, 목록 조회, SSE 스트리밍",
    tools=["execute", "sessions_list", "sessions_stream"],
)
async def execute_task(
    body: ExecuteRequest,
    http_request: Request,
    _: str = Depends(verify_token),
):
    """
    Claude Code 실행 (SSE 스트리밍)

    세션을 생성(또는 resume)하고 Claude Code를 백그라운드에서 실행합니다.
    SSE 스트림의 첫 이벤트로 agent_session_id를 전달합니다.

    - agent_session_id 미제공: 새 세션 생성 (서버가 ID 생성)
    - agent_session_id 제공: 기존 세션 resume
    """
    task_manager = get_task_manager()

    # 동시 실행 제한 확인
    if not resource_manager.can_acquire():
        raise HTTPException(
            status_code=503,
            detail={
                "error": {
                    "code": "RATE_LIMIT_EXCEEDED",
                    "message": f"동시 실행 제한 초과 (max={resource_manager.max_concurrent})",
                    "details": {},
                }
            },
        )

    # caller_info 조립: body에 있으면 그대로, 없으면 HTTP Request에서 수집 (source="api")
    caller_info = body.caller_info or {
        "source": "api",
        "ip": http_request.client.host if http_request.client else None,
        "user_agent": http_request.headers.get("user-agent"),
        "referer": http_request.headers.get("referer"),
        "forwarded_for": http_request.headers.get("x-forwarded-for"),
    }

    # attachment_paths → extra_context_items 변환 (대시보드 라우트와 동일 패턴)
    extra_context_items = body.context_items
    if body.attachment_paths:
        attachment_item = {
            "key": "attached_files",
            "label": "첨부 파일",
            "content": (
                "다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:\n"
                + "\n".join(f"- {p}" for p in body.attachment_paths)
            ),
        }
        extra_context_items = (extra_context_items or []) + [attachment_item]

    # 세션 생성 또는 resume
    try:
        task = await task_manager.create_task(CreateTaskParams(
            prompt=body.prompt,
            agent_session_id=body.agent_session_id,
            client_id=body.client_id,
            allowed_tools=body.allowed_tools,
            disallowed_tools=body.disallowed_tools,
            use_mcp=body.use_mcp,
            context=body.context.model_dump() if body.context else None,
            context_items=[item.model_dump() for item in body.context.items] if body.context else None,
            extra_context_items=extra_context_items,
            model=body.model,
            folder_id=body.folder_id,
            system_prompt=body.system_prompt,
            profile_id=body.profile,
            caller_info=caller_info,
            attachment_paths=body.attachment_paths,
        ))
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "code": "INVALID_PROFILE",
                    "message": str(e),
                    "details": {},
                }
            },
        )
    except TaskConflictError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "SESSION_CONFLICT",
                    "message": f"이미 실행 중인 세션입니다: {body.agent_session_id}",
                    "details": {},
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

    agent_session_id = task.agent_session_id

    # 리스너를 먼저 등록하여 start_execution 직후 broadcast 이벤트 유실 방지
    # (session_events_sse_generator L116-117과 동일한 'queue 사전 등록' 패턴)
    event_queue = asyncio.Queue()
    await task_manager.listener_manager.add_listener(agent_session_id, event_queue)

    try:
        # 백그라운드에서 Claude 실행 시작
        await task_manager.executor.start_execution(
            agent_session_id=agent_session_id,
            claude_runner=get_soul_engine(),
            resource_manager=resource_manager,
        )
    except Exception:
        # start_execution 실패 시 listener cleanup.
        # 성공 경로에서는 stream_live_events finally가 remove_listener를 담당하므로
        # 여기서의 cleanup과 상호 배타적이다.
        await task_manager.listener_manager.remove_listener(agent_session_id, event_queue)
        raise

    async def event_generator():
        """SSE 이벤트 생성기

        첫 이벤트: init (agent_session_id 전달).
        이후 라이브 이벤트는 stream_live_events에 위임 (finally remove_listener는 코어가 담당).
        """
        # 첫 이벤트: agent_session_id + node_id 전달 (라우트 책임 보존)
        yield _build_init_event(agent_session_id)

        # 라이브 루프 + finally remove_listener는 코어에 위임.
        # /execute 응답은 complete/error 시 종료 → break_on_terminal=True.
        # 외부 generator가 aclose될 때 inner도 명시적으로 닫아야 finally가 실행됨 (PEP 525).
        inner = stream_live_events(
            agent_session_id, task_manager, event_queue,
            break_on_terminal=True,
        )
        try:
            async for sse_event in inner:
                yield sse_event
        finally:
            await inner.aclose()

    return EventSourceResponse(event_generator())


@router.get(
    "/events/{agent_session_id}/stream",
    responses={404: {"model": ErrorResponse}},
)
async def session_stream(
    agent_session_id: str,
    _: str = Depends(verify_token),
    last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
):
    """
    세션 SSE 스트림 재연결/재구독

    연결 끊김 후 재연결하거나, resume 후 SSE 구독에 사용합니다.

    - Running 세션: 현재 상태 전송 후 라이브 이벤트 수신
    - Completed 세션: 저장된 결과 즉시 반환
    - Error 세션: 저장된 에러 즉시 반환
    - Last-Event-ID: 해당 ID 이후의 미수신 이벤트 재전송
    """
    parsed_last_event_id: Optional[int] = None
    if last_event_id is not None:
        try:
            parsed_last_event_id = int(last_event_id)
        except (ValueError, TypeError):
            logger.warning(f"Invalid Last-Event-ID header: {last_event_id!r}")

    task_manager = get_task_manager()
    task = await task_manager.get_task(agent_session_id)

    if not task:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": f"세션을 찾을 수 없습니다: {agent_session_id}",
                    "details": {},
                }
            },
        )

    async def event_generator():
        # init 이벤트 (세션 확인용)
        yield _build_init_event(agent_session_id)

        # 이미 완료된 세션이면 즉시 결과 반환
        if task.status == TaskStatus.COMPLETED:
            yield {
                "event": "complete",
                "data": json.dumps({
                    "type": "complete",
                    "result": task.result,
                    "claude_session_id": task.claude_session_id,
                    "attachments": [],
                }, ensure_ascii=False, default=str),
            }
            return

        if task.status == TaskStatus.ERROR:
            yield {
                "event": "error",
                "data": json.dumps({
                    "type": "error",
                    "message": task.error,
                }, ensure_ascii=False, default=str),
            }
            return

        if task.status == TaskStatus.INTERRUPTED:
            # interrupted 세션은 터미널 이벤트를 보내지 않음.
            # 상태는 세션 목록 SSE(/sessions/stream)에서 "interrupted"로 정확히 전달됨.
            return

        # Running 세션 → 리스너 등록하고 이벤트 대기
        event_queue = asyncio.Queue()
        await task_manager.listener_manager.add_listener(agent_session_id, event_queue)

        # 재연결 상태 전송 + 미수신 이벤트 재전송 (라우트 책임 보존)
        await task_manager.executor.send_reconnect_status(
            agent_session_id, event_queue,
            last_event_id=parsed_last_event_id,
        )

        # 라이브 루프 + finally remove_listener는 코어에 위임.
        # /events/{id}/stream 재연결 응답은 complete/error 시 종료 → break_on_terminal=True.
        # 외부 generator가 aclose될 때 inner도 명시적으로 닫아야 finally가 실행됨 (PEP 525).
        inner = stream_live_events(
            agent_session_id, task_manager, event_queue,
            break_on_terminal=True,
        )
        try:
            async for sse_event in inner:
                yield sse_event
        finally:
            await inner.aclose()

    return EventSourceResponse(event_generator())


@router.get(
    "/sessions/{agent_session_id}",
    response_model=SessionResponse,
    responses={404: {"model": ErrorResponse}},
)
async def get_session(
    agent_session_id: str,
    _: str = Depends(verify_token),
):
    """세션 상태 조회"""
    task_manager = get_task_manager()
    task = await task_manager.get_task(agent_session_id)

    if not task:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": f"세션을 찾을 수 없습니다: {agent_session_id}",
                    "details": {},
                }
            },
        )

    return task_to_response(task)


@router.post(
    "/sessions/{agent_session_id}/intervene",
    status_code=202,
    responses={
        404: {"model": ErrorResponse},
    },
)
async def intervene_session(
    agent_session_id: str,
    request: InterveneRequest,
    http_request: Request,
    _: str = Depends(verify_token),
):
    """
    세션에 개입 메시지 전송 (자동 resume 포함)

    Running 세션이면 intervention queue에 추가합니다.
    완료된 세션이면 자동으로 resume하여 대화를 이어갑니다.

    F-9 fix(2026-05-08): caller_info를 wire에 운반한다. body.caller_info가
    있으면 그대로(슬랙봇 등 외부 클라이언트), 없으면 HTTP 메타로 source='api'
    fallback 조립 (인증 없는 직접 호출 케이스).
    """
    try:
        # body.caller_info가 있으면 그대로, 없으면 HTTP Request에서 수집 (source='api').
        # /execute 라우트와 동일 패턴 — 인증 없는 직접 API 호출자도 graceful fallback.
        caller_info = request.caller_info or {
            "source": "api",
            "ip": http_request.client.host if http_request.client else None,
            "user_agent": http_request.headers.get("user-agent"),
            "referer": http_request.headers.get("referer"),
            "forwarded_for": http_request.headers.get("x-forwarded-for"),
        }
        return await intervention_service.intervene(
            agent_session_id=agent_session_id,
            text=request.text,
            user=request.user,
            attachment_paths=request.attachment_paths,
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
                    "message": f"세션을 찾을 수 없습니다: {agent_session_id}",
                    "details": {},
                }
            },
        )


@router.post(
    "/sessions/{agent_session_id}/respond",
    status_code=200,
    responses={
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def respond_to_input_request(
    agent_session_id: str,
    request: InputResponseRequest,
    _: str = Depends(verify_token),
):
    """
    AskUserQuestion에 대한 사용자 응답 전달

    input_request SSE 이벤트를 수신한 클라이언트가
    사용자의 선택을 이 엔드포인트로 전달합니다.
    """
    try:
        return await intervention_service.respond_to_input(
            agent_session_id=agent_session_id,
            request_id=request.request_id,
            answers=request.answers,
            task_manager=get_task_manager(),
        )
    except InputRequestNotPendingError as e:
        raise HTTPException(
            status_code=422,
            detail={
                "error": {
                    "code": "REQUEST_NOT_PENDING",
                    "message": f"대기 중인 input_request가 없습니다: {e.request_id}",
                    "details": {},
                }
            },
        )
    except TaskNotFoundError:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "SESSION_NOT_FOUND",
                    "message": f"세션을 찾을 수 없습니다: {agent_session_id}",
                    "details": {},
                }
            },
        )
    except TaskNotRunningError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "SESSION_NOT_RUNNING",
                    "message": f"세션이 실행 중이 아닙니다: {agent_session_id}",
                    "details": {},
                }
            },
        )
