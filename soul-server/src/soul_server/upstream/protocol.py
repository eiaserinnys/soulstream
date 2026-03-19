"""소울스트림 ↔ 소울 서버 WebSocket 메시지 프로토콜 정의.

모든 메시지는 JSON으로 직렬화되며, 반드시 "type" 필드를 포함한다.
"""

from __future__ import annotations

from typing import Any, TypedDict


# ─────────────────────────────────────────────────────
# Upstream → Node (소울스트림 → 소울 서버) 명령
# ─────────────────────────────────────────────────────

class CreateSessionCmd(TypedDict, total=False):
    type: str            # "create_session"
    prompt: str
    profile: str
    request_id: str
    allowed_tools: list[str]
    disallowed_tools: list[str]
    use_mcp: bool
    context: dict[str, Any]
    context_items: list[dict[str, Any]]
    extra_context_items: list[dict[str, Any]]


class InterveneCmd(TypedDict):
    type: str            # "intervene"
    session_id: str
    text: str
    user: str


class RespondCmd(TypedDict):
    type: str            # "respond"
    session_id: str
    request_id: str
    answers: dict[str, Any]


class ListSessionsCmd(TypedDict, total=False):
    type: str            # "list_sessions"
    request_id: str


class HealthCheckCmd(TypedDict, total=False):
    type: str            # "health_check"
    request_id: str


# ─────────────────────────────────────────────────────
# Node → Upstream (소울 서버 → 소울스트림) 응답/이벤트
# ─────────────────────────────────────────────────────

class NodeRegistration(TypedDict):
    type: str            # "node_register"
    node_id: str
    host: str
    port: int
    capabilities: dict[str, Any]


class SessionCreated(TypedDict):
    type: str            # "session_created"
    session_id: str
    request_id: str


class SessionEvent(TypedDict, total=False):
    type: str            # "event"
    session_id: str
    # 나머지 필드는 기존 SSE 이벤트 페이로드와 동일


class SessionsUpdate(TypedDict):
    type: str            # "sessions_update"
    sessions: list[dict[str, Any]]
    request_id: str


class HealthStatus(TypedDict):
    type: str            # "health_status"
    runners: dict[str, Any]
    request_id: str


class ErrorResponse(TypedDict, total=False):
    type: str            # "error"
    message: str
    request_id: str
    command_type: str


# ─────────────────────────────────────────────────────
# 명령 타입 상수
# ─────────────────────────────────────────────────────

CMD_CREATE_SESSION = "create_session"
CMD_INTERVENE = "intervene"
CMD_RESPOND = "respond"
CMD_LIST_SESSIONS = "list_sessions"
CMD_HEALTH_CHECK = "health_check"

EVT_NODE_REGISTER = "node_register"
EVT_SESSION_CREATED = "session_created"
EVT_EVENT = "event"
EVT_SESSIONS_UPDATE = "sessions_update"
EVT_HEALTH_STATUS = "health_status"
EVT_ERROR = "error"
