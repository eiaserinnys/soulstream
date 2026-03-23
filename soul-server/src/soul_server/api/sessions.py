"""
Sessions API - 세션 목록 조회 및 SSE 스트리밍

대시보드가 세션 목록을 조회하고 변경 사항을 실시간으로 구독하는 API입니다.

- GET /sessions: 세션 목록 조회 (JSON)
- GET /sessions/stream: 세션 목록 변경 SSE 구독
- GET /sessions/{id}/history: 세션 히스토리 + 라이브 스트리밍 SSE 구독
- PUT /sessions/{id}/read-position: 읽음 위치 갱신
"""

import asyncio
import json
import logging
from typing import AsyncGenerator, Literal, Optional

from fastapi import APIRouter, Header, HTTPException, Path as FastAPIPath, Query
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from soul_server.models import SessionsListResponse
from soul_server.service.task_models import Task, TaskStatus as TaskModelStatus
from soul_server.service.task_manager import get_task_manager
from soul_server.service.session_broadcaster import get_session_broadcaster

logger = logging.getLogger(__name__)


async def stream_session_events(
    agent_session_id: str,
    last_stored_id: int,
    task_manager,
    event_queue: asyncio.Queue,
) -> AsyncGenerator[dict, None]:
    """Parts 2+3: history_sync 발행 + 라이브 이벤트 스트리밍.

    event_queue는 호출자가 히스토리 읽기 전에 add_listener로 등록한 큐.
    last_stored_id 이하의 이벤트는 히스토리에서 이미 전송했으므로 건너뛴다.

    반환: raw event dict. 호출자가 SSE id/event/data 필드를 래핑.
    """
    # Part 2: history_sync 발행
    current_task = await task_manager.get_task(agent_session_id)
    is_live = current_task and current_task.status == TaskModelStatus.RUNNING

    sync_payload: dict = {
        "type": "history_sync",
        "last_event_id": last_stored_id,
        "is_live": is_live,
    }
    if current_task:
        sync_payload["status"] = current_task.status.value
    yield sync_payload

    # Part 3: 라이브 스트리밍 (dedup)
    try:
        while True:
            try:
                event = await asyncio.wait_for(event_queue.get(), timeout=30.0)
                # 히스토리에서 이미 전송된 이벤트는 건너뛴다
                event_id = event.get("_event_id")
                if event_id is not None and event_id <= last_stored_id:
                    continue
                yield event
            except asyncio.TimeoutError:
                yield {"type": "keepalive"}
    finally:
        await task_manager.remove_listener(agent_session_id, event_queue)


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
        folder_id: str | None = Query(None, description="폴더 ID 필터 (UUID 또는 시스템 ID, 예: 'claude')"),
        folder_name: str | None = Query(None, description="폴더 표시 이름 필터 (folder_id와 동시 제공 시 folder_id 우선)"),
        node_id: str | None = Query(None, description="노드 ID 필터 (SOULSTREAM_NODE_ID 값)"),
        node_name: str | None = Query(None, description="노드 이름 필터 (node_id와 동일 컬럼, node_id 우선)"),
        status: str | None = Query(None, description="상태 필터 (쉼표 구분 가능, 예: running 또는 completed,error)"),
    ):
        """세션 목록 조회 (페이지네이션, 타입/폴더/노드/상태 필터 지원)"""
        task_manager = get_task_manager()

        # folder_name → folder_id 해소
        resolved_folder_id = folder_id
        if folder_name and not folder_id:
            all_folders = await task_manager.get_all_folders()
            matched = next((f for f in all_folders if f.get("name") == folder_name), None)
            resolved_folder_id = matched["id"] if matched else None

        # node_name → node_id (동일 컬럼)
        resolved_node_id = node_id or node_name

        # status 파싱: 쉼표 구분 다중값 지원
        status_filter: str | list[str] | None = None
        if status:
            parts = [s.strip() for s in status.split(",") if s.strip()]
            status_filter = parts if len(parts) > 1 else (parts[0] if parts else None)

        sessions, total = await task_manager.get_all_sessions(
            offset=offset, limit=limit, session_type=session_type,
            folder_id=resolved_folder_id, node_id=resolved_node_id,
            status=status_filter,
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

            sessions, total = await task_manager.get_all_sessions()

            yield {
                "event": "session_list",
                "data": json.dumps({
                    "type": "session_list",
                    "sessions": sessions,
                    "total": total,
                }, ensure_ascii=False, default=str),
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
                            "data": json.dumps(event, ensure_ascii=False, default=str),
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
        from soul_server.service.postgres_session_db import get_session_db
        db = get_session_db()

        entry = await db.read_one_event(agent_session_id, event_id)
        if entry is None:
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
        try:
            ev = json.loads(entry["payload"])
        except (json.JSONDecodeError, KeyError):
            ev = {}
        return {"id": entry["id"], "event": ev}

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

        async def sse_wrapper():
            # 리스너를 히스토리 읽기 전에 등록하여
            # DB 읽기와 리스너 등록 사이의 경합으로 이벤트가 누락되는 것을 방지한다.
            event_queue = asyncio.Queue()
            await task_manager.add_listener(agent_session_id, event_queue)
            entered_stream = False

            try:
                # Part 1: SessionDB에서 저장 이벤트 스트리밍
                from soul_server.service.postgres_session_db import get_session_db
                db = get_session_db()
                last_stored_id = 0

                try:
                    async for event_id, event_type, payload_text in db.stream_events_raw(
                        agent_session_id, after_id=after_id,
                    ):
                        last_stored_id = max(last_stored_id, event_id)
                        yield {
                            "id": str(event_id),
                            "event": event_type,
                            "data": payload_text,
                        }
                except Exception as e:
                    logger.error(f"Failed to read events for {agent_session_id}: {e}")

                # Parts 2+3: stream_session_events에 위임 (dedup은 stream_session_events 내부에서 처리)
                # stream_session_events의 finally에서 remove_listener를 호출한다.
                entered_stream = True
                async for event_dict in stream_session_events(
                    agent_session_id, last_stored_id, task_manager, event_queue,
                ):
                    event_type = event_dict.get("type", "unknown")
                    if event_type == "keepalive":
                        yield {"comment": "keepalive"}
                    else:
                        # _event_id를 pop하여 data JSON에서 제거하되, SSE id: 필드로 전달
                        event_id = event_dict.pop("_event_id", None)
                        sse_event: dict = {"event": event_type, "data": json.dumps(event_dict, ensure_ascii=False, default=str)}
                        if event_id is not None:
                            sse_event["id"] = str(event_id)
                        yield sse_event
            finally:
                if not entered_stream:
                    # stream_session_events에 진입하지 못했으면 직접 정리
                    await task_manager.remove_listener(agent_session_id, event_queue)

        return EventSourceResponse(sse_wrapper())

    class ReadPositionRequest(BaseModel):
        last_read_event_id: int

    @router.put("/sessions/{session_id}/read-position")
    async def update_read_position(
        session_id: str,
        body: ReadPositionRequest,
    ):
        """읽음 위치 갱신 API

        클라이언트가 세션을 확인했을 때 호출하여 read-position을 갱신한다.
        갱신 후 SSE로 크로스 대시보드 동기화 이벤트를 발행한다.
        """
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

        # 갱신 후 현재 값을 조회하여 SSE 브로드캐스트
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

    return router
