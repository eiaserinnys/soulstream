"""UpstreamAdapter — 소울스트림 서버에 역방향 WebSocket 연결하는 어댑터.

기존 HTTP API와 동일한 TaskManager 메서드를 호출하며,
연결 방향만 반대(소울 서버 → 소울스트림)이다.
소울스트림에 연결하지 않아도 기존 독립 실행 모드에는 영향이 없다.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

import aiohttp

from .protocol import (
    CMD_CREATE_SESSION,
    CMD_HEALTH_CHECK,
    CMD_INTERVENE,
    CMD_LIST_SESSIONS,
    CMD_RESPOND,
    EVT_ERROR,
    EVT_EVENT,
    EVT_HEALTH_STATUS,
    EVT_NODE_REGISTER,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)
from .reconnect import ReconnectPolicy

if TYPE_CHECKING:
    from soul_server.service.engine_adapter import SoulEngineAdapter
    from soul_server.service.resource_manager import ResourceManager
    from soul_server.service.session_broadcaster import SessionBroadcaster
    from soul_server.service.task_manager import TaskManager

logger = logging.getLogger(__name__)


class UpstreamAdapter:
    """소울스트림 서버에 역방향 연결하는 어댑터.

    기존 HTTP API와 동일한 TaskManager 메서드를 호출하며,
    연결 방향만 반대(소울 서버 → 소울스트림).
    """

    def __init__(
        self,
        task_manager: TaskManager,
        soul_engine: SoulEngineAdapter,
        resource_manager: ResourceManager,
        session_broadcaster: SessionBroadcaster,
        upstream_url: str,
        node_id: str,
        host: str = "",
        port: int = 0,
    ) -> None:
        self._tm = task_manager
        self._engine = soul_engine
        self._rm = resource_manager
        self._broadcaster = session_broadcaster
        self._url = upstream_url
        self._node_id = node_id
        self._host = host
        self._port = port

        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._reconnect = ReconnectPolicy()
        self._running = False
        self._stream_tasks: dict[str, asyncio.Task] = {}
        self._broadcast_task: asyncio.Task | None = None
        self._broadcast_queue: asyncio.Queue | None = None

    # ─── Lifecycle ──────────────────────────────────

    async def run(self) -> None:
        """연결 루프 시작. 연결이 끊기면 자동 재연결한다.

        외부에서 asyncio.create_task(adapter.run())으로 호출한다.
        """
        self._running = True
        self._session = aiohttp.ClientSession()

        try:
            while self._running:
                try:
                    await self._connect_and_serve()
                except (
                    aiohttp.WSServerHandshakeError,
                    aiohttp.ClientConnectorError,
                    aiohttp.ClientError,
                    ConnectionError,
                    OSError,
                ) as e:
                    if not self._running:
                        break
                    logger.warning("Upstream connection failed: %s", e)
                except Exception:
                    if not self._running:
                        break
                    logger.exception("Unexpected error in upstream connection")

                # 연결 종료 시 broadcast 리스너 정리
                await self._stop_broadcast()

                if self._running:
                    await self._reconnect.wait()
        finally:
            await self._cleanup()

    async def shutdown(self) -> None:
        """연결 종료. lifespan shutdown에서 호출한다."""
        self._running = False

        # broadcast 태스크 정리
        await self._stop_broadcast()

        # 스트리밍 태스크 취소
        for task in self._stream_tasks.values():
            task.cancel()
        self._stream_tasks.clear()

        if self._ws and not self._ws.closed:
            await self._ws.close()

        if self._session and not self._session.closed:
            await self._session.close()

    # ─── Connection ─────────────────────────────────

    async def _connect_and_serve(self) -> None:
        """WebSocket 연결 + 노드 등록 + 세션 동기화 + 명령 수신 루프."""
        logger.info("Connecting to upstream: %s", self._url)

        self._ws = await self._session.ws_connect(self._url)
        self._reconnect.reset()
        logger.info("Connected to upstream (node_id=%s)", self._node_id)

        # 노드 등록
        await self._send({
            "type": EVT_NODE_REGISTER,
            "node_id": self._node_id,
            "host": self._host,
            "port": self._port,
            "capabilities": {
                "max_concurrent": self._rm.max_concurrent,
            },
        })

        # 세션 동기화: 구독 먼저 → 초기 전송 (이벤트 유실 방지)
        await self._start_broadcast()
        await self._send_initial_sessions()

        # 명령 수신 루프
        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    cmd = json.loads(msg.data)
                    await self._handle_command(cmd)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON from upstream: %s", msg.data[:200])
                except Exception:
                    logger.exception("Error handling upstream command")
            elif msg.type == aiohttp.WSMsgType.ERROR:
                logger.warning("WebSocket error: %s", self._ws.exception())
                break
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                break

        logger.info("Upstream connection closed")

    # ─── Session Sync ─────────────────────────────

    async def _send_initial_sessions(self) -> None:
        """현재 세션 목록을 오케스트레이터에 전송."""
        sessions, total = await self._tm.get_all_sessions()
        await self._send({
            "type": EVT_SESSIONS_UPDATE,
            "sessions": sessions,
            "total": total,
        })
        logger.info("Sent initial sessions to upstream (count=%d)", total)

    async def _start_broadcast(self) -> None:
        """SessionBroadcaster에 리스너 등록 + 소비 태스크 시작."""
        # 이전 연결의 잔여 리스너가 있으면 정리
        await self._stop_broadcast()

        self._broadcast_queue = asyncio.Queue()
        await self._broadcaster.add_listener(self._broadcast_queue)
        self._broadcast_task = asyncio.create_task(
            self._broadcast_session_changes(),
            name="upstream-broadcast-sessions",
        )

    async def _stop_broadcast(self) -> None:
        """broadcast 태스크 취소 + 리스너 해제."""
        if self._broadcast_task and not self._broadcast_task.done():
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        self._broadcast_task = None

        if self._broadcast_queue is not None:
            await self._broadcaster.remove_listener(self._broadcast_queue)
            self._broadcast_queue = None

    async def _broadcast_session_changes(self) -> None:
        """SessionBroadcaster 이벤트를 오케스트레이터 프로토콜로 변환하여 전송."""
        try:
            while self._running:
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
            # _handle_create_session이 request_id 포함 응답을 이미 보내므로,
            # broadcast 경로에서는 세션 정보를 포함한 보강 메시지를 전송
            session_info = event.get("session", {})
            await self._send({
                "type": EVT_SESSION_CREATED,
                "session_id": session_info.get("agent_session_id", ""),
                "session": session_info,
            })
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

    # ─── Command Dispatch ───────────────────────────

    async def _handle_command(self, cmd: dict) -> None:
        """소울스트림에서 받은 명령을 TaskManager 메서드로 라우팅."""
        cmd_type = cmd.get("type", "")
        request_id = cmd.get("request_id", "")

        try:
            match cmd_type:
                case "create_session":
                    await self._handle_create_session(cmd)
                case "intervene":
                    await self._handle_intervene(cmd)
                case "respond":
                    await self._handle_respond(cmd)
                case "list_sessions":
                    await self._handle_list_sessions(cmd)
                case "health_check":
                    await self._handle_health_check(cmd)
                case _:
                    await self._send_error(
                        f"Unknown command type: {cmd_type}",
                        request_id=request_id,
                        command_type=cmd_type,
                    )
        except Exception as e:
            logger.exception("Error handling command %s", cmd_type)
            await self._send_error(
                str(e),
                request_id=request_id,
                command_type=cmd_type,
            )

    async def _handle_create_session(self, cmd: dict) -> None:
        """세션 생성 명령 처리."""
        task = await self._tm.create_task(
            prompt=cmd["prompt"],
            allowed_tools=cmd.get("allowed_tools"),
            disallowed_tools=cmd.get("disallowed_tools"),
            use_mcp=cmd.get("use_mcp", True),
            context=cmd.get("context"),
            context_items=cmd.get("context_items"),
            extra_context_items=cmd.get("extra_context_items"),
        )
        session_id = task.agent_session_id

        # 실행 시작
        await self._tm.start_execution(
            agent_session_id=session_id,
            claude_runner=self._engine,
            resource_manager=self._rm,
        )

        # 이벤트 스트리밍 시작
        stream_task = asyncio.create_task(
            self._stream_events(session_id),
            name=f"upstream-stream-{session_id}",
        )
        self._stream_tasks[session_id] = stream_task

        # request_id 응답만 전송. 세션 정보는 SessionBroadcaster 경로로 전달됨.
        request_id = cmd.get("request_id", "")
        if request_id:
            await self._send({
                "type": EVT_SESSION_CREATED,
                "session_id": session_id,
                "request_id": request_id,
            })

    async def _handle_intervene(self, cmd: dict) -> None:
        """개입 명령 처리."""
        session_id = cmd["session_id"]
        result = await self._tm.add_intervention(
            agent_session_id=session_id,
            text=cmd["text"],
            user=cmd.get("user", "upstream"),
        )

        # auto-resume 시 실행 재시작
        if result.get("auto_resumed"):
            await self._tm.start_execution(
                agent_session_id=session_id,
                claude_runner=self._engine,
                resource_manager=self._rm,
            )
            # 이벤트 스트리밍이 없으면 시작
            if session_id not in self._stream_tasks or self._stream_tasks[session_id].done():
                stream_task = asyncio.create_task(
                    self._stream_events(session_id),
                    name=f"upstream-stream-{session_id}",
                )
                self._stream_tasks[session_id] = stream_task

    async def _handle_respond(self, cmd: dict) -> None:
        """AskUserQuestion 응답 처리."""
        self._tm.deliver_input_response(
            agent_session_id=cmd["session_id"],
            request_id=cmd["request_id"],
            answers=cmd["answers"],
        )

    async def _handle_list_sessions(self, cmd: dict) -> None:
        """세션 목록 반환."""
        sessions, total = await self._tm.get_all_sessions()
        await self._send({
            "type": EVT_SESSIONS_UPDATE,
            "sessions": sessions,
            "total": total,
            "request_id": cmd.get("request_id", ""),
        })

    async def _handle_health_check(self, cmd: dict) -> None:
        """헬스체크 응답."""
        stats = self._rm.get_stats()
        await self._send({
            "type": EVT_HEALTH_STATUS,
            "runners": stats,
            "node_id": self._node_id,
            "request_id": cmd.get("request_id", ""),
        })

    # ─── Event Streaming ────────────────────────────

    async def _stream_events(self, session_id: str) -> None:
        """TaskManager에서 이벤트를 받아 WebSocket으로 소울스트림에 전송."""
        queue: asyncio.Queue = asyncio.Queue()
        added = await self._tm.add_listener(session_id, queue)
        if not added:
            logger.warning("Failed to add listener for session %s", session_id)
            return

        try:
            while self._running:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=30.0)
                except asyncio.TimeoutError:
                    continue

                if event is None:
                    break  # 세션 종료 시그널

                await self._send({
                    "type": EVT_EVENT,
                    "session_id": session_id,
                    "event": event,
                })

                # complete/error 이벤트면 스트리밍 종료
                event_type = event.get("type", "")
                if event_type in ("complete", "error"):
                    break
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Error streaming events for session %s", session_id)
        finally:
            await self._tm.remove_listener(session_id, queue)
            self._stream_tasks.pop(session_id, None)

    # ─── Helpers ────────────────────────────────────

    async def _send(self, data: dict) -> None:
        """WebSocket으로 JSON 메시지 전송."""
        if self._ws and not self._ws.closed:
            await self._ws.send_json(data)

    async def _send_error(
        self,
        message: str,
        request_id: str = "",
        command_type: str = "",
    ) -> None:
        """에러 응답 전송."""
        await self._send({
            "type": EVT_ERROR,
            "message": message,
            "request_id": request_id,
            "command_type": command_type,
        })

    async def _cleanup(self) -> None:
        """연결 정리."""
        await self._stop_broadcast()

        for task in self._stream_tasks.values():
            task.cancel()
        self._stream_tasks.clear()

        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
        self._ws = None
