"""
NodeConnection — soul-server 노드의 WebSocket 연결을 래핑.

노드 정보 추적, 명령 전송, 수신 메시지 디스패치, 응답 대기(Future) 관리.
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from soulstream_server.constants import (
    CMD_CREATE_SESSION,
    CMD_INTERVENE,
    CMD_RESPOND,
    CMD_SUBSCRIBE_EVENTS,
    COMMAND_TIMEOUT,
    EVT_ERROR,
    EVT_EVENT,
    EVT_HEALTH_STATUS,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)

logger = logging.getLogger(__name__)

# Callback type aliases
OnCloseCallback = Callable[["NodeConnection"], Coroutine[Any, Any, None]]
OnSessionChangeCallback = Callable[
    [str, str, dict | None], Coroutine[Any, Any, None]
]  # (node_id, change_type, data)


class NodeConnection:
    """soul-server 노드 하나의 WebSocket 연결."""

    def __init__(
        self,
        ws: WebSocket,
        node_id: str,
        host: str = "",
        port: int = 0,
        capabilities: list[str] | None = None,
        on_close: OnCloseCallback | None = None,
        on_session_change: OnSessionChangeCallback | None = None,
    ):
        self._ws = ws
        self.node_id = node_id
        self.host = host
        self.port = port
        self.capabilities = capabilities or []
        self.connected_at = datetime.now(timezone.utc)

        self._sessions: dict[str, dict] = {}
        self._agent_profiles: dict = {}  # 연결 직후 _fetch_agent_profiles()로 populate됨
        self._portrait_cache: dict[str, bytes] = {}  # agent_id → portrait bytes (등록 메시지에서 수신)
        self._request_counter = 0
        self._pending: dict[str, asyncio.Future] = {}
        self._subscribe_listeners: dict[str, dict[str, Callable]] = {}

        self.on_close = on_close
        self.on_session_change = on_session_change

    @property
    def sessions(self) -> dict[str, dict]:
        return self._sessions

    @property
    def agent_profiles(self) -> dict:
        return self._agent_profiles

    @property
    def portrait_cache(self) -> dict[str, bytes]:
        return self._portrait_cache

    def set_agent_data(
        self, profiles: dict, portrait_cache: dict[str, bytes]
    ) -> None:
        """에이전트 프로필과 portrait 캐시를 설정한다."""
        self._agent_profiles = profiles
        self._portrait_cache = portrait_cache

    @property
    def session_count(self) -> int:
        return len(self._sessions)

    def to_info(self) -> dict:
        return {
            "nodeId": self.node_id,
            "host": self.host,
            "port": self.port,
            "capabilities": self.capabilities,
            "connectedAt": self.connected_at.isoformat(),
            "sessionCount": self.session_count,
            "status": "connected",
        }

    # --- 명령 전송 ---

    def _next_request_id(self) -> str:
        self._request_counter += 1
        return f"req-{self._request_counter}-{int(time.time() * 1000)}"

    async def _send(self, data: dict) -> None:
        try:
            await self._ws.send_json(data)
        except Exception as e:
            # websockets 라이브러리가 close frame 이후 send를 시도하면
            # "Cannot call 'send' once a close message has been sent." RuntimeError를 발생시킨다.
            # 이를 WebSocketDisconnect로 정규화하여 호출자가 일관되게 처리할 수 있게 한다.
            raise WebSocketDisconnect(code=1011, reason=str(e)) from e

    async def _send_command(
        self, command: str, payload: dict, timeout: float = COMMAND_TIMEOUT
    ) -> dict:
        request_id = self._next_request_id()
        future: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        message = {"type": command, "requestId": request_id, **payload}
        await self._send(message)

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"Command {command} timed out after {timeout}s (request_id={request_id})"
            )
        finally:
            self._pending.pop(request_id, None)

    async def send_create_session(
        self,
        prompt: str,
        session_id: str | None = None,
        profile: str | None = None,
        allowed_tools: list[str] | None = None,
        disallowed_tools: list[str] | None = None,
        use_mcp: bool | None = None,
        node_id: str | None = None,
        folder_id: str | None = None,
    ) -> dict:
        payload: dict[str, Any] = {"prompt": prompt}
        if session_id:
            payload["agentSessionId"] = session_id
        if profile:
            payload["profile"] = profile
        if allowed_tools is not None:
            payload["allowedTools"] = allowed_tools
        if disallowed_tools is not None:
            payload["disallowedTools"] = disallowed_tools
        if use_mcp is not None:
            payload["useMcp"] = use_mcp
        if node_id is not None:
            payload["nodeId"] = node_id
        if folder_id is not None:
            payload["folderId"] = folder_id
        return await self._send_command(CMD_CREATE_SESSION, payload)

    async def send_intervene(
        self, session_id: str, text: str, user: str = ""
    ) -> dict:
        return await self._send_command(
            CMD_INTERVENE,
            {"agentSessionId": session_id, "text": text, "user": user},
        )

    async def send_respond(
        self, session_id: str, request_id: str, answers: dict
    ) -> dict:
        return await self._send_command(
            CMD_RESPOND,
            {
                "agentSessionId": session_id,
                "requestId": request_id,
                "answers": answers,
            },
        )

    async def send_subscribe_events(
        self, session_id: str, callback: Callable
    ) -> str:
        subscribe_id = str(uuid.uuid4())

        if session_id not in self._subscribe_listeners:
            self._subscribe_listeners[session_id] = {}
        self._subscribe_listeners[session_id][subscribe_id] = callback

        await self._send({
            "type": CMD_SUBSCRIBE_EVENTS,
            "agentSessionId": session_id,
            "subscribeId": subscribe_id,
        })
        return subscribe_id

    def unsubscribe_events(self, session_id: str, subscribe_id: str) -> None:
        listeners = self._subscribe_listeners.get(session_id)
        if listeners:
            listeners.pop(subscribe_id, None)
            if not listeners:
                del self._subscribe_listeners[session_id]

    # --- 수신 메시지 처리 ---

    async def handle_message(self, data: dict) -> None:
        msg_type = data.get("type")
        request_id = data.get("requestId")

        # pending request에 대한 응답
        if request_id and request_id in self._pending:
            future = self._pending.pop(request_id)
            if not future.done():
                if msg_type == EVT_ERROR:
                    future.set_exception(
                        RuntimeError(data.get("message", "Unknown error"))
                    )
                else:
                    future.set_result(data)
            return

        # 이벤트 디스패치
        if msg_type == EVT_SESSION_CREATED:
            await self._on_session_created(data)
        elif msg_type == EVT_EVENT:
            await self._on_event(data)
        elif msg_type == EVT_SESSIONS_UPDATE:
            await self._on_sessions_update(data)
        elif msg_type == EVT_SESSION_UPDATED:
            await self._on_session_updated(data)
        elif msg_type == EVT_SESSION_DELETED:
            await self._on_session_deleted(data)
        elif msg_type == EVT_HEALTH_STATUS:
            await self._on_health_status(data)
        elif msg_type == EVT_ERROR:
            logger.warning(
                "Error from node %s: %s", self.node_id, data.get("message")
            )
        else:
            logger.debug(
                "Unknown message type from node %s: %s", self.node_id, msg_type
            )

    async def _on_session_created(self, data: dict) -> None:
        session_id = data.get("agentSessionId")
        if session_id:
            self._sessions[session_id] = {
                "agentSessionId": session_id,
                "status": data.get("status", "running"),
                "nodeId": self.node_id,
            }
            if self.on_session_change:
                await self.on_session_change(
                    self.node_id, "session_created", data
                )

    async def _on_event(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("sessionId")
        subscribe_id = data.get("subscribeId")

        if session_id and session_id in self._subscribe_listeners:
            listeners = self._subscribe_listeners[session_id]
            if subscribe_id and subscribe_id in listeners:
                await listeners[subscribe_id](data)
            else:
                # broadcast to all listeners for this session
                for cb in list(listeners.values()):
                    await cb(data)

    async def _on_sessions_update(self, data: dict) -> None:
        sessions = data.get("sessions", [])
        self._sessions.clear()
        for s in sessions:
            sid = s.get("agentSessionId") or s.get("session_id")
            if sid:
                self._sessions[sid] = s
        if self.on_session_change:
            await self.on_session_change(
                self.node_id, "sessions_update", data
            )

    async def _on_session_updated(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if session_id and session_id in self._sessions:
            self._sessions[session_id].update(data)
        if self.on_session_change:
            await self.on_session_change(
                self.node_id, "session_updated", data
            )

    async def _on_session_deleted(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if session_id:
            self._sessions.pop(session_id, None)
        if self.on_session_change:
            await self.on_session_change(
                self.node_id, "session_deleted", data
            )

    async def _on_health_status(self, data: dict) -> None:
        logger.debug("Health status from node %s: %s", self.node_id, data)

    # --- 연결 종료 ---

    async def close(self) -> None:
        # cancel all pending futures
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
        self._subscribe_listeners.clear()

        try:
            await self._ws.close()
        except Exception:
            pass

        if self.on_close:
            cb = self.on_close
            self.on_close = None  # 이중 호출 방지 — ws_handler finally와 register_node 중복 호출
            await cb(self)
