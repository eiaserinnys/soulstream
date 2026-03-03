"""
Sessions API - 세션 목록 조회 및 SSE 스트리밍

대시보드가 세션 목록을 조회하고 변경 사항을 실시간으로 구독하는 API입니다.

- GET /sessions: 세션 목록 조회 (JSON)
- GET /sessions/stream: 세션 목록 변경 SSE 구독
"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends
from sse_starlette.sse import EventSourceResponse

from soul_server.models import (
    SessionInfo,
    SessionsListResponse,
    TaskStatus,
)
from soul_server.service.task_models import Task
from soul_server.api.auth import verify_token

logger = logging.getLogger(__name__)


def _task_to_session_info(task: Task) -> dict:
    """Task를 세션 정보 dict로 변환"""
    updated_at = task.completed_at or task.created_at
    return {
        "agent_session_id": task.agent_session_id,
        "status": task.status.value,
        "prompt": task.prompt,
        "created_at": task.created_at.isoformat(),
        "updated_at": updated_at.isoformat(),
    }


def create_sessions_router(
    task_manager,
    session_broadcaster,
    auth_dependency=None,
) -> APIRouter:
    """세션 API 라우터 생성

    Args:
        task_manager: TaskManager 인스턴스
        session_broadcaster: SessionBroadcaster 인스턴스
        auth_dependency: 인증 의존성 (None이면 verify_token 사용)

    Returns:
        APIRouter 인스턴스
    """
    router = APIRouter()

    # 인증 의존성 설정
    auth_dep = auth_dependency if auth_dependency else Depends(verify_token)

    @router.get("/sessions", response_model=SessionsListResponse)
    async def get_sessions():
        """세션 목록 조회"""
        tasks = task_manager.get_all_sessions()
        sessions = [_task_to_session_info(t) for t in tasks]
        return {"sessions": sessions}

    @router.get("/sessions/stream")
    async def sessions_stream():
        """세션 목록 변경 SSE 스트림

        연결 시 현재 세션 목록을 session_list 이벤트로 전송합니다.
        이후 세션 생성/업데이트/삭제 시 해당 이벤트를 발행합니다.
        """

        async def event_generator():
            # 초기 세션 목록 전송
            tasks = task_manager.get_all_sessions()
            sessions = [_task_to_session_info(t) for t in tasks]

            yield {
                "event": "session_list",
                "data": json.dumps({
                    "type": "session_list",
                    "sessions": sessions,
                }, ensure_ascii=False),
            }

            # 리스너 등록
            event_queue = asyncio.Queue()
            await session_broadcaster.add_listener(event_queue)

            try:
                while True:
                    try:
                        event = await asyncio.wait_for(
                            event_queue.get(),
                            timeout=30.0,
                        )
                        yield {
                            "event": event.get("type", "unknown"),
                            "data": json.dumps(event, ensure_ascii=False),
                        }
                    except asyncio.TimeoutError:
                        # keepalive
                        yield {"comment": "keepalive"}

            finally:
                await session_broadcaster.remove_listener(event_queue)

        return EventSourceResponse(event_generator())

    return router
