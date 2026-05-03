"""EventRelay — broadcaster 이벤트 + 세션 이벤트를 orch-server로 relay.

UpstreamAdapter에서 분리된 이벤트 도메인 컴포넌트:
- broadcaster 이벤트(session_created/updated/deleted/input_request)를 WS 메시지로 변환
- TaskManager 이벤트(text_delta, tool_use, complete 등)를 EVT_EVENT 메시지로 relay
- broadcast 큐 lifecycle 관리(start/stop)

설계 원칙:
- adapter는 인스턴스를 생성하여 composition으로 보유
- send_fn/stream_tasks는 reference 공유로 동기화 (mutation은 양쪽 모두 가능)
- _running 플래그는 callable로 받아 adapter 측 상태와 연동
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Awaitable, Callable

from .protocol import (
    EVT_EVENT,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
)

if TYPE_CHECKING:
    from soul_server.service.session_broadcaster import SessionBroadcaster
    from soul_server.service.task_manager import TaskManager

logger = logging.getLogger(__name__)


class EventRelay:
    """broadcaster + session 이벤트 relay 컴포넌트."""

    def __init__(
        self,
        *,
        task_manager: "TaskManager",
        broadcaster: "SessionBroadcaster",
        send_fn: Callable[[dict], Awaitable[None]],
        stream_tasks: dict[str, asyncio.Task],
        is_running: Callable[[], bool],
    ) -> None:
        self._tm = task_manager
        self._broadcaster = broadcaster
        self._send = send_fn
        self._stream_tasks = stream_tasks
        self._is_running = is_running

        self._broadcast_task: asyncio.Task | None = None
        self._broadcast_queue: asyncio.Queue | None = None

    # ─── Broadcast lifecycle ──────────────────────────

    async def start_broadcast(self) -> None:
        """SessionBroadcaster에 리스너 등록 + 소비 태스크 시작."""
        # 이전 연결의 잔여 리스너가 있으면 정리
        await self.stop_broadcast()

        self._broadcast_queue = self._broadcaster.add_client()
        self._broadcast_task = asyncio.create_task(
            self._broadcast_session_changes(),
            name="upstream-broadcast-sessions",
        )

    async def stop_broadcast(self) -> None:
        """broadcast 태스크 취소 + 리스너 해제."""
        if self._broadcast_task and not self._broadcast_task.done():
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        self._broadcast_task = None

        if self._broadcast_queue is not None:
            self._broadcaster.remove_client(self._broadcast_queue)
            self._broadcast_queue = None

    async def _broadcast_session_changes(self) -> None:
        """SessionBroadcaster 이벤트를 오케스트레이터 프로토콜로 변환하여 전송."""
        try:
            while self._is_running():
                try:
                    event = await asyncio.wait_for(
                        self._broadcast_queue.get(), timeout=30.0,
                    )
                except asyncio.TimeoutError:
                    continue

                try:
                    await self._dispatch_broadcast_event(event)
                except Exception:
                    logger.exception(
                        "Error dispatching broadcast event: %s",
                        event.get("type"),
                    )
        except asyncio.CancelledError:
            pass

    async def _dispatch_broadcast_event(self, event: dict) -> None:
        """개별 broadcaster 이벤트를 오케스트레이터 프로토콜로 변환하여 전송."""
        event_type = event.get("type", "")

        if event_type == "session_created":
            # broadcaster: {"type": "session_created", "session": to_session_info()}
            # _handle_create_session이 requestId 포함 응답을 이미 보내므로,
            # broadcast 경로에서는 세션 정보를 포함한 보강 메시지를 전송
            session_info = event.get("session", {})
            folder_id = event.get("folder_id")
            msg: dict = {
                "type": EVT_SESSION_CREATED,
                "agentSessionId": session_info.get("agent_session_id", ""),
                "session": session_info,
            }
            if folder_id is not None:
                msg["folderId"] = folder_id
            await self._send(msg)
        elif event_type == "session_updated":
            await self._send({
                "type": EVT_SESSION_UPDATED,
                **{k: v for k, v in event.items() if k != "type"},
            })
        elif event_type == "session_deleted":
            await self._send({
                "type": EVT_SESSION_DELETED,
                **{k: v for k, v in event.items() if k != "type"},
            })
        elif event_type == "input_request":
            # 빌드 20: input_request는 session-events 스트림에 broadcast됨.
            # orch-server PushNotifier가 받아 디바이스 알림을 발사할 수 있도록
            # 별도 메시지 타입으로 forwarding한다 (없으면 worker→orch 경로 누락).
            await self._send({
                "type": "input_request",
                **{k: v for k, v in event.items() if k != "type"},
            })

    # ─── Event Streaming ──────────────────────────────

    async def relay_events(self, session_id: str) -> None:
        """TaskManager 이벤트를 WebSocket으로 relay하는 공통 루프.

        complete/error에서 종료하지 않는다.
        세션이 완료된 후 새 turn이 시작되면 동일 스트림으로 이벤트가 계속 전달돼야 한다.
        세션 종료는 None 센티넬 또는 WebSocket 연결 해제로 처리한다.
        """
        queue: asyncio.Queue = asyncio.Queue()
        await self._tm.add_listener(session_id, queue)

        try:
            while self._is_running():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    continue

                if event is None:
                    break  # 세션 종료 시그널

                await self._send({
                    "type": EVT_EVENT,
                    "agentSessionId": session_id,
                    "event": event,
                })
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Error relaying events for session %s", session_id)
        finally:
            await self._tm.remove_listener(session_id, queue)
            if self._stream_tasks.get(session_id) is asyncio.current_task():
                self._stream_tasks.pop(session_id, None)

    async def stream_events(self, session_id: str) -> None:
        """create_session에서 시작되는 이벤트 스트리밍."""
        await self.relay_events(session_id)
