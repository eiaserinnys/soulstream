"""Inbound node event dispatch and session cache policy."""

import json
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
OnEventIngestCallback = Callable[[str, dict], Coroutine[Any, Any, None]]


def _nested_session(data: dict) -> dict:
    session = data.get("session")
    return session if isinstance(session, dict) else {}


def _session_id_from_payload(data: dict) -> str | None:
    session = _nested_session(data)
    session_id = (
        data.get("agentSessionId")
        or data.get("agent_session_id")
        or data.get("sessionId")
        or data.get("session_id")
        or session.get("agentSessionId")
        or session.get("agent_session_id")
        or session.get("sessionId")
        or session.get("session_id")
    )
    return session_id if isinstance(session_id, str) and session_id else None


def _event_payload(data: dict) -> dict:
    event = data.get("event")
    if isinstance(event, dict):
        return event
    payload = data.get("payload")
    return payload if isinstance(payload, dict) else {}


def _string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _meaningful_text(value: Any) -> str:
    text = _string_value(value)
    if not text or text in {"{}", "[]", "null", "undefined"}:
        return ""
    if not any(ch.isalnum() for ch in text):
        return ""
    return text


def _json_preview(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return _meaningful_text(value)
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return _meaningful_text(value)


def _first_text_from_record(record: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        text = _meaningful_text(record.get(key))
        if text:
            return text
    return ""


def _input_request_excerpt(event: dict) -> str:
    questions = event.get("questions")
    if isinstance(questions, list):
        for question in questions:
            if isinstance(question, dict):
                text = _first_text_from_record(
                    question, ("question", "header", "label", "description")
                )
                if text:
                    return text
            else:
                text = _meaningful_text(question)
                if text:
                    return text
    return _first_text_from_record(event, ("prompt", "message", "title"))


def _tool_input_excerpt(tool_input: Any) -> str:
    if isinstance(tool_input, dict):
        text = _first_text_from_record(
            tool_input,
            ("plan", "message", "summary", "content", "prompt", "question", "command"),
        )
        if text:
            return text
        if len(tool_input) == 1:
            return _json_preview(next(iter(tool_input.values())))
    return _json_preview(tool_input)


def _notification_excerpt(event: dict) -> str:
    title = _meaningful_text(event.get("title"))
    message = _meaningful_text(event.get("message"))
    if title and message and title != message:
        return f"{title}: {message}"
    return message or title or _meaningful_text(event.get("key"))


def _session_name(session: dict, session_id: str) -> str:
    return (
        _first_text_from_record(
            session,
            ("display_name", "displayName", "name", "title", "prompt", "agentName"),
        )
        or session_id[:8]
    )


class NodeInboundEvents:
    """Handle node-originated events and local session/listener state."""

    def __init__(
        self,
        *,
        node_id: str,
        on_session_change: OnSessionChangeCallback | None = None,
        on_event_ingest: OnEventIngestCallback | None = None,
    ):
        self.node_id = node_id
        self.on_session_change = on_session_change
        self.on_event_ingest = on_event_ingest
        self._sessions: dict[str, dict] = {}
        self._subscribe_listeners: dict[str, dict[str, Callable]] = {}
        self._tool_inputs: dict[tuple[str, str], dict] = {}

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
        session = _nested_session(data)
        session_id = _session_id_from_payload(data)
        if session_id:
            cached = {
                **session,
                "agentSessionId": session_id,
                "status": data.get("status") or session.get("status", "running"),
                "nodeId": self.node_id,
            }
            for key in ("caller_source", "callerSource", "folder_id", "folderId"):
                if key in data:
                    cached[key] = data[key]
            self._sessions[session_id] = cached
            await self._notify_session_change("session_created", data)

    async def _on_event(self, data: dict) -> None:
        session_id = _session_id_from_payload(data)
        subscribe_id = data.get("subscribeId")
        event = _event_payload(data)

        if self.on_event_ingest:
            await self.on_event_ingest(self.node_id, data)

        if session_id and session_id in self._subscribe_listeners:
            listeners = self._subscribe_listeners[session_id]
            if subscribe_id and subscribe_id in listeners:
                await listeners[subscribe_id](data)
            else:
                for callback in list(listeners.values()):
                    await callback(data)

        if not session_id:
            return

        self._cache_tool_input(session_id, event)
        signal = self._response_wait_signal(session_id, event, data)
        if signal:
            await self._notify_session_change("input_request", signal)

    async def _on_sessions_update(self, data: dict) -> None:
        sessions = data.get("sessions", [])
        self._sessions.clear()
        for session in sessions:
            session_id = _session_id_from_payload(session)
            if session_id:
                self._sessions[session_id] = session
        await self._notify_session_change("sessions_update", data)

    async def _on_session_updated(self, data: dict) -> None:
        session_id = _session_id_from_payload(data)
        if session_id and session_id in self._sessions:
            self._sessions[session_id].update(data)
        await self._notify_session_change("session_updated", data)

    async def _on_session_deleted(self, data: dict) -> None:
        session_id = _session_id_from_payload(data)
        if session_id:
            self._sessions.pop(session_id, None)
            for key in [k for k in self._tool_inputs if k[0] == session_id]:
                self._tool_inputs.pop(key, None)
        await self._notify_session_change("session_deleted", data)

    async def _on_health_status(self, data: dict) -> None:
        logger.debug("Health status from node %s: %s", self.node_id, data)

    def _cache_tool_input(self, session_id: str, event: dict) -> None:
        if event.get("type") != "tool_start":
            return
        tool_name = event.get("tool_name") or event.get("toolName")
        if tool_name != "ExitPlanMode":
            return
        tool_use_id = event.get("tool_use_id") or event.get("toolUseId")
        if not isinstance(tool_use_id, str) or not tool_use_id:
            return
        tool_input = event.get("tool_input") or event.get("toolInput") or {}
        if isinstance(tool_input, dict):
            self._tool_inputs[(session_id, tool_use_id)] = tool_input

    def _response_wait_signal(
        self, session_id: str, event: dict, envelope: dict
    ) -> dict | None:
        event_type = event.get("type")
        if not isinstance(event_type, str):
            return None

        signal = self._response_wait_fields(session_id, event, event_type)
        if signal is None:
            return None

        session = self._sessions.get(session_id, {})
        caller_source = (
            session.get("caller_source")
            or session.get("callerSource")
            or envelope.get("caller_source")
            or envelope.get("callerSource")
        )
        session_type = (
            session.get("session_type")
            or session.get("sessionType")
            or envelope.get("session_type")
            or envelope.get("sessionType")
        )
        folder_id = (
            session.get("folder_id")
            if "folder_id" in session
            else session.get("folderId")
        )
        if folder_id is None:
            folder_id = (
                envelope.get("folder_id")
                if "folder_id" in envelope
                else envelope.get("folderId")
            )
        foreground_count = len(self._subscribe_listeners.get(session_id, {}))
        return {
            "type": EVT_INPUT_REQUEST,
            "agent_session_id": session_id,
            "agentSessionId": session_id,
            "session_id": session_id,
            "session_type": session_type,
            "caller_source": caller_source,
            "folder_id": folder_id,
            "folderId": folder_id,
            "session_name": _session_name(session, session_id),
            "foreground_observer_count": foreground_count,
            **signal,
        }

    def _response_wait_fields(
        self, session_id: str, event: dict, event_type: str
    ) -> dict | None:
        if event_type == "input_request":
            return {
                "response_wait_kind": "ask_user_question",
                "response_wait_id": event.get("request_id") or event.get("requestId"),
                "request_id": event.get("request_id") or event.get("requestId"),
                "tool_use_id": event.get("tool_use_id") or event.get("toolUseId"),
                "prompt": _input_request_excerpt(event)
                or "에이전트가 입력을 기다리고 있습니다",
            }

        if event_type == "claude_runtime_mode_state":
            mode = event.get("mode")
            tool_name = event.get("tool_name") or event.get("toolName")
            if mode != "plan" or event.get("active") is not False:
                return None
            if tool_name != "ExitPlanMode":
                return None
            tool_use_id = event.get("tool_use_id") or event.get("toolUseId")
            cached_input = (
                self._tool_inputs.get((session_id, tool_use_id))
                if isinstance(tool_use_id, str)
                else None
            )
            return {
                "response_wait_kind": "exit_plan_mode",
                "response_wait_id": tool_use_id,
                "tool_use_id": tool_use_id,
                "tool_name": tool_name,
                "prompt": _tool_input_excerpt(cached_input) or "ExitPlanMode",
            }

        if event_type == "claude_runtime_notification":
            notification_type = (
                event.get("notification_type") or event.get("notificationType") or ""
            )
            key = event.get("key") or ""
            if str(notification_type).lower() != "permission" and str(key).lower() != "permission":
                return None
            notification_id = event.get("notification_id") or event.get("notificationId")
            return {
                "response_wait_kind": "permission_prompt",
                "response_wait_id": notification_id,
                "notification_id": notification_id,
                "tool_use_id": event.get("tool_use_id") or event.get("toolUseId"),
                "prompt": _notification_excerpt(event) or "권한 확인이 필요합니다",
            }

        if event_type == "tool_approval_requested":
            tool_name = _meaningful_text(event.get("tool_name")) or "tool"
            tool_input = event.get("tool_input") or event.get("toolInput") or {}
            excerpt = _tool_input_excerpt(tool_input)
            return {
                "response_wait_kind": "tool_approval",
                "response_wait_id": event.get("approval_id") or event.get("approvalId"),
                "approval_id": event.get("approval_id") or event.get("approvalId"),
                "tool_use_id": event.get("tool_use_id") or event.get("toolUseId"),
                "tool_name": tool_name,
                "prompt": f"{tool_name}: {excerpt}" if excerpt else tool_name,
            }

        return None
