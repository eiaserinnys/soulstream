"""Inbound node event dispatch and session cache policy."""

import logging
from collections.abc import Callable, Coroutine
from typing import Any

from soulstream_server.constants import (
    EVT_ERROR,
    EVT_EVENT,
    EVT_HEALTH_STATUS,
    EVT_INPUT_REQUEST,
    EVT_SESSION_CREATED,
    EVT_SESSION_DELETED,
    EVT_SESSION_UPDATED,
    EVT_SESSIONS_UPDATE,
)

logger = logging.getLogger(__name__)

OnSessionChangeCallback = Callable[
    [str, str, dict | None], Coroutine[Any, Any, None]
]


class NodeInboundEvents:
    """Handle node-originated events and local session/listener state."""

    def __init__(
        self,
        *,
        node_id: str,
        on_session_change: OnSessionChangeCallback | None = None,
    ):
        self.node_id = node_id
        self.on_session_change = on_session_change
        self._sessions: dict[str, dict] = {}
        self._subscribe_listeners: dict[str, dict[str, Callable]] = {}

    @property
    def sessions(self) -> dict[str, dict]:
        return self._sessions

    @property
    def subscribe_listeners(self) -> dict[str, dict[str, Callable]]:
        return self._subscribe_listeners

    @property
    def session_count(self) -> int:
        return len(self._sessions)

    def register_subscribe_listener(
        self, session_id: str, subscribe_id: str, callback: Callable
    ) -> None:
        if session_id not in self._subscribe_listeners:
            self._subscribe_listeners[session_id] = {}
        self._subscribe_listeners[session_id][subscribe_id] = callback

    def unsubscribe_events(self, session_id: str, subscribe_id: str) -> None:
        listeners = self._subscribe_listeners.get(session_id)
        if listeners:
            listeners.pop(subscribe_id, None)
            if not listeners:
                del self._subscribe_listeners[session_id]

    def clear_subscribe_listeners(self) -> None:
        self._subscribe_listeners.clear()

    async def handle(self, data: dict) -> None:
        msg_type = data.get("type")

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
        elif msg_type == EVT_INPUT_REQUEST:
            await self._notify_session_change("input_request", data)
        elif msg_type == EVT_ERROR:
            logger.warning(
                "Error from node %s: %s", self.node_id, data.get("message")
            )
        else:
            logger.debug(
                "Unknown message type from node %s: %s", self.node_id, msg_type
            )

    async def _notify_session_change(self, change_type: str, data: dict) -> None:
        if self.on_session_change:
            await self.on_session_change(self.node_id, change_type, data)

    async def _on_session_created(self, data: dict) -> None:
        session_id = data.get("agentSessionId")
        if session_id:
            self._sessions[session_id] = {
                "agentSessionId": session_id,
                "status": data.get("status", "running"),
                "nodeId": self.node_id,
            }
            await self._notify_session_change("session_created", data)

    async def _on_event(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("sessionId")
        subscribe_id = data.get("subscribeId")

        if session_id and session_id in self._subscribe_listeners:
            listeners = self._subscribe_listeners[session_id]
            if subscribe_id and subscribe_id in listeners:
                await listeners[subscribe_id](data)
            else:
                for callback in list(listeners.values()):
                    await callback(data)

    async def _on_sessions_update(self, data: dict) -> None:
        sessions = data.get("sessions", [])
        self._sessions.clear()
        for session in sessions:
            session_id = session.get("agentSessionId") or session.get("session_id")
            if session_id:
                self._sessions[session_id] = session
        await self._notify_session_change("sessions_update", data)

    async def _on_session_updated(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if session_id and session_id in self._sessions:
            self._sessions[session_id].update(data)
        await self._notify_session_change("session_updated", data)

    async def _on_session_deleted(self, data: dict) -> None:
        session_id = data.get("agentSessionId") or data.get("session_id")
        if session_id:
            self._sessions.pop(session_id, None)
        await self._notify_session_change("session_deleted", data)

    async def _on_health_status(self, data: dict) -> None:
        logger.debug("Health status from node %s: %s", self.node_id, data)
