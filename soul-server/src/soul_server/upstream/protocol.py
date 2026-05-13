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
    folderId: str
    allowed_tools: list[str]
    disallowed_tools: list[str]
    use_mcp: bool
    context: dict[str, Any]
    context_items: list[dict[str, Any]]
    extra_context_items: list[dict[str, Any]]
    caller_info: dict[str, Any]


class InterveneCmd(TypedDict):
    type: str            # "intervene"
    agentSessionId: str  # 실제 전송 키와 일치 (구: session_id)
    text: str
    user: str


class RespondCmd(TypedDict, total=False):
    """AskUserQuestion 응답 명령.

    inputRequestId가 신규 정본(input_request의 request_id).
    request_id는 구버전 orch-server 호환 fallback (deprecated).
    requestId는 _send_command가 부여하는 WS 명령 ID(payload에 직접 넣지 않음).
    """
    type: str             # "respond"
    agentSessionId: str   # 실제 전송 키와 일치 (구: session_id)
    inputRequestId: str   # 신규 정본 — input_request의 request_id
    request_id: str       # 구버전 호환 fallback (deprecated)
    answers: dict[str, Any]


class ListSessionsCmd(TypedDict, total=False):
    type: str            # "list_sessions"
    request_id: str


class HealthCheckCmd(TypedDict, total=False):
    type: str            # "health_check"
    request_id: str


class SubscribeEventsCmd(TypedDict):
    type: str            # "subscribe_events"
    session_id: str
    after_id: int        # 이 ID 초과 이벤트만 전송. 0이면 처음부터
    request_id: str      # 현재 미사용, 향후 응답 라우팅용 예약 필드 (빈 문자열 허용)


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
CMD_SUBSCRIBE_EVENTS = "subscribe_events"

# Attachment WS reverse-proxy commands (orch ↔ node).
# 노드 self-reported host:port HTTP 가정 폐기 — 신뢰 가능한 WS wire로 통합한다.
# 운영 로그: eias-shopping/eias-linegames가 host=127.0.0.1로 보고하여 orch에서 도달 불가
# 였던 결함 회로(2026-05-13) 차단. atom 작업 이력 260513.01 (orch-relay-attachment).
CMD_UPLOAD_ATTACHMENT = "upload_attachment"
CMD_DELETE_SESSION_ATTACHMENTS = "delete_session_attachments"
# Phase 2 (atom 260513.02 — chat-inline-attachment): 채팅 영역 사용자 발화
# 말풍선에 첨부 이미지 인라인 표시. orch가 GET /api/attachments/files에서
# cross-node 다운로드를 WS로 위임. directory traversal 가드는 노드 측
# file_manager.is_under_base()로 검증.
CMD_DOWNLOAD_ATTACHMENT = "download_attachment"

# Claude Code OAuth 명령 (orchestrator → soul-server)
CMD_CLAUDE_AUTH_STATUS = "claude_auth_status"           # 토큰 존재 여부 조회
CMD_CLAUDE_AUTH_SET_TOKEN = "claude_auth_set_token"     # 토큰 설정
CMD_CLAUDE_AUTH_DELETE_TOKEN = "claude_auth_delete_token"  # 토큰 삭제
CMD_CLAUDE_AUTH_GET_USAGE = "claude_auth_get_usage"     # Usage 조회 (Anthropic API 호출)
CMD_CLAUDE_AUTH_GET_PROFILE = "claude_auth_get_profile" # 계정 프로필(email 등) 조회

EVT_NODE_REGISTER = "node_register"
EVT_SESSION_CREATED = "session_created"
EVT_EVENT = "event"
EVT_SESSIONS_UPDATE = "sessions_update"
EVT_SESSION_UPDATED = "session_updated"
EVT_SESSION_DELETED = "session_deleted"
EVT_HEALTH_STATUS = "health_status"
EVT_ERROR = "error"
