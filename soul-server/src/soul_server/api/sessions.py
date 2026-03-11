"""
Sessions API - 세션 목록 조회 및 SSE 스트리밍

대시보드가 세션 목록을 조회하고 변경 사항을 실시간으로 구독하는 API입니다.

- GET /sessions: 세션 목록 조회 (JSON)
- GET /sessions/stream: 세션 목록 변경 SSE 구독
- GET /sessions/{id}/history: 세션 히스토리 + 라이브 스트리밍 SSE 구독
"""

import asyncio
import json
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Header, HTTPException, Path as FastAPIPath, Query
from sse_starlette.sse import EventSourceResponse

from soul_server.models import SessionsListResponse
from soul_server.service.task_models import Task, TaskStatus as TaskModelStatus
from soul_server.service.task_manager import get_task_manager
from soul_server.service.session_broadcaster import get_session_broadcaster

logger = logging.getLogger(__name__)


def create_sessions_router() -> APIRouter:
    """세션 API 라우터 생성

    TaskManager와 SessionBroadcaster는 각 핸들러에서 lazy 싱글톤 참조를 사용합니다.

    Returns:
        APIRouter 인스턴스
    """
    router = APIRouter()

    @router.get("/sessions", response_model=SessionsListResponse)
    async def get_sessions(
        offset: int = Query(0, ge=0, description="건너뛸 항목 수"),
        limit: int = Query(0, ge=0, description="반환할 최대 항목 수 (0이면 전체)"),
        session_type: Literal["claude", "llm"] | None = Query(None, description="세션 타입 필터: claude | llm"),
    ):
        """세션 목록 조회 (페이지네이션, 타입 필터 지원)"""
        task_manager = get_task_manager()
        sessions, total = task_manager.get_all_sessions(
            offset=offset, limit=limit, session_type=session_type,
        )
        return {"sessions": sessions, "total": total}

    @router.get("/sessions/stream")
    async def sessions_stream():
        """세션 목록 변경 SSE 스트림

        연결 시 현재 세션 목록을 session_list 이벤트로 전송합니다.
        이후 세션 생성/업데이트/삭제 시 해당 이벤트를 발행합니다.
        """

        async def event_generator():
            # 초기 세션 목록 전송
            task_manager = get_task_manager()
            session_broadcaster = get_session_broadcaster()

            sessions, total = task_manager.get_all_sessions()

            yield {
                "event": "session_list",
                "data": json.dumps({
                    "type": "session_list",
                    "sessions": sessions,
                    "total": total,
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

    @router.get("/sessions/{agent_session_id}/events/{event_id}")
    async def get_event(
        agent_session_id: str,
        event_id: int = FastAPIPath(..., ge=1, description="이벤트 ID (1 이상)"),
    ):
        """개별 이벤트 조회

        클라이언트에서 truncate된 콘텐츠의 전체 내용을 요청할 때 사용합니다.
        """
        task_manager = get_task_manager()
        event_store = task_manager.event_store
        if not event_store:
            raise HTTPException(status_code=500, detail="EventStore not available")

        record = event_store.read_one(agent_session_id, event_id)
        if record is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": {
                        "code": "EVENT_NOT_FOUND",
                        "message": f"이벤트를 찾을 수 없습니다: {event_id}",
                        "details": {},
                    }
                },
            )
        return record

    @router.get("/sessions/{agent_session_id}/history")
    async def session_history(
        agent_session_id: str,
        last_event_id: Optional[str] = Header(None, alias="Last-Event-ID"),
    ):
        """세션 히스토리 + 라이브 스트리밍 SSE

        대시보드용 엔드포인트. 저장된 이벤트를 먼저 전송하고,
        running 세션이면 라이브 이벤트를 계속 스트리밍합니다.

        기존 /events/{id}/stream과의 차이점:
        - 저장된 이벤트 먼저 전송 후 history_sync 이벤트 발행
        - complete/error 후에도 연결 유지 (resume 대비)

        Headers:
            Last-Event-ID: 마지막으로 수신한 이벤트 ID. 이후 이벤트만 전송.
        """
        task_manager = get_task_manager()

        # 세션 존재 확인
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

        # Last-Event-ID 파싱
        after_id = 0
        if last_event_id is not None:
            try:
                after_id = int(last_event_id)
            except (ValueError, TypeError):
                logger.warning(f"Invalid Last-Event-ID header: {last_event_id!r}")

        async def event_generator():
            # 1. EventStore에서 저장된 이벤트 조회 및 전송
            event_store = task_manager.event_store
            stored_events = []
            last_stored_id = 0

            if event_store:
                try:
                    if after_id > 0:
                        stored_events = event_store.read_since(agent_session_id, after_id)
                    else:
                        stored_events = event_store.read_all(agent_session_id)
                except Exception as e:
                    logger.error(f"Failed to read events for {agent_session_id}: {e}")
                    # Graceful degradation - proceed with live streaming only

                # 저장된 이벤트 전송
                for record in stored_events:
                    event_id = record["id"]
                    event = record["event"]
                    last_stored_id = max(last_stored_id, event_id)

                    yield {
                        "id": str(event_id),
                        "event": event.get("type", "unknown"),
                        "data": json.dumps(event, ensure_ascii=False),
                    }

            # 2. history_sync 이벤트 발행
            # 현재 세션 상태 확인 — 클라이언트가 이 status를 정본으로 사용
            current_task = await task_manager.get_task(agent_session_id)
            is_live = current_task and current_task.status == TaskModelStatus.RUNNING

            sync_payload: dict = {
                "type": "history_sync",
                "last_event_id": last_stored_id,
                "is_live": is_live,
            }
            if current_task:
                sync_payload["status"] = current_task.status.value

            yield {
                "event": "history_sync",
                "data": json.dumps(sync_payload, ensure_ascii=False),
            }

            # 3. running 세션이면 라이브 스트리밍
            # (complete/error 후에도 연결 유지 - resume 대비)
            event_queue = asyncio.Queue()
            await task_manager.add_listener(agent_session_id, event_queue)

            try:
                while True:
                    try:
                        event = await asyncio.wait_for(
                            event_queue.get(),
                            timeout=30.0,
                        )

                        # event_id를 get으로 추출 (원본 이벤트 변경하지 않음)
                        event_id = event.get("_event_id") if isinstance(event, dict) else None
                        data = {k: v for k, v in event.items() if k != "_event_id"} if isinstance(event, dict) else event

                        sse_event = {
                            "event": event.get("type", "unknown"),
                            "data": json.dumps(data, ensure_ascii=False),
                        }
                        if event_id is not None:
                            sse_event["id"] = str(event_id)
                        yield sse_event

                        # 기존 /events/{id}/stream과 달리 complete/error 후에도 계속
                        # (resume 시 새 이벤트 수신 가능)

                    except asyncio.TimeoutError:
                        # keepalive
                        yield {"comment": "keepalive"}

            finally:
                await task_manager.remove_listener(agent_session_id, event_queue)

        return EventSourceResponse(event_generator())

    return router
