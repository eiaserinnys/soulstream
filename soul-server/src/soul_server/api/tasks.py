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
from fastapi import APIRouter, Header, HTTPException, Depends
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
    TaskStatus,
)
from soul_server.service import resource_manager, get_soul_engine
from soul_server.api.auth import verify_token
from soul_server.cogito.reflector_setup import reflect

logger = logging.getLogger(__name__)

router = APIRouter()


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
    request: ExecuteRequest,
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

    # 세션 생성 또는 resume
    try:
        task = await task_manager.create_task(
            prompt=request.prompt,
            agent_session_id=request.agent_session_id,
            client_id=request.client_id,
            allowed_tools=request.allowed_tools,
            disallowed_tools=request.disallowed_tools,
            use_mcp=request.use_mcp,
            context=request.context.model_dump() if request.context else None,
            context_items=[item.model_dump() for item in request.context.items] if request.context else None,
            extra_context_items=request.context_items,
            model=request.model,
            folder_id=request.folder_id,
        )
    except TaskConflictError:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "SESSION_CONFLICT",
                    "message": f"이미 실행 중인 세션입니다: {request.agent_session_id}",
                    "details": {},
                }
            },
        )

    agent_session_id = task.agent_session_id

    # 백그라운드에서 Claude 실행 시작
    await task_manager.start_execution(
        agent_session_id=agent_session_id,
        claude_runner=get_soul_engine(),
        resource_manager=resource_manager,
    )

    async def event_generator():
        """SSE 이벤트 생성기

        첫 이벤트: init (agent_session_id 전달)
        이후: 실행 이벤트들
        마지막: complete 또는 error
        """
        # 첫 이벤트: agent_session_id 전달
        yield {
            "event": "init",
            "data": json.dumps({
                "type": "init",
                "agent_session_id": agent_session_id,
            }, ensure_ascii=False, default=str),
        }

        event_queue = asyncio.Queue()
        await task_manager.add_listener(agent_session_id, event_queue)

        try:
            while True:
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=30.0)
                    event_id = event.get("_event_id")
                    data = {k: v for k, v in event.items() if k != "_event_id"}
                    sse_event = {
                        "event": event.get("type", "unknown"),
                        "data": json.dumps(data, ensure_ascii=False, default=str),
                    }
                    if event_id is not None:
                        sse_event["id"] = str(event_id)
                    yield sse_event

                    # 완료 또는 에러면 종료
                    if event.get("type") in ["complete", "error"]:
                        break

                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}

        finally:
            await task_manager.remove_listener(agent_session_id, event_queue)

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
        yield {
            "event": "init",
            "data": json.dumps({
                "type": "init",
                "agent_session_id": agent_session_id,
            }, ensure_ascii=False, default=str),
        }

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
        await task_manager.add_listener(agent_session_id, event_queue)

        try:
            # 재연결 상태 전송 + 미수신 이벤트 재전송
            await task_manager.send_reconnect_status(
                agent_session_id, event_queue,
                last_event_id=parsed_last_event_id,
            )

            while True:
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=30.0)

                    event_id = event.get("_event_id") if isinstance(event, dict) else None
                    data = {k: v for k, v in event.items() if k != "_event_id"} if isinstance(event, dict) else event
                    sse_event = {
                        "event": event.get("type", "unknown"),
                        "data": json.dumps(data, ensure_ascii=False, default=str),
                    }
                    if event_id is not None:
                        sse_event["id"] = str(event_id)
                    yield sse_event

                    if event.get("type") in ["complete", "error"]:
                        break

                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}

        finally:
            await task_manager.remove_listener(agent_session_id, event_queue)

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
    _: str = Depends(verify_token),
):
    """
    세션에 개입 메시지 전송 (자동 resume 포함)

    Running 세션이면 intervention queue에 추가합니다.
    완료된 세션이면 자동으로 resume하여 대화를 이어갑니다.
    """
    task_manager = get_task_manager()

    try:
        result = await task_manager.add_intervention(
            agent_session_id=agent_session_id,
            text=request.text,
            user=request.user,
            attachment_paths=request.attachment_paths,
        )

        if result.get("auto_resumed"):
            # 자동 resume → 실행 시작
            await task_manager.start_execution(
                agent_session_id=agent_session_id,
                claude_runner=get_soul_engine(),
                resource_manager=resource_manager,
            )
            return {
                "auto_resumed": True,
                "agent_session_id": agent_session_id,
            }
        else:
            return {
                "queued": True,
                "queue_position": result["queue_position"],
            }

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
    task_manager = get_task_manager()

    try:
        success = task_manager.deliver_input_response(
            agent_session_id=agent_session_id,
            request_id=request.request_id,
            answers=request.answers,
        )

        if success:
            return {"delivered": True, "request_id": request.request_id}
        else:
            raise HTTPException(
                status_code=422,
                detail={
                    "error": {
                        "code": "REQUEST_NOT_PENDING",
                        "message": f"대기 중인 input_request가 없습니다: {request.request_id}",
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
