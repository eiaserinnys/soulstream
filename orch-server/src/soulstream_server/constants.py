"""
프로토콜 상수 — soul-server UpstreamAdapter와 호환.
"""

# Commands (soulstream-server -> node)
CMD_CREATE_SESSION = "create_session"
CMD_INTERVENE = "intervene"
CMD_RESPOND = "respond"
CMD_LIST_SESSIONS = "list_sessions"
CMD_HEALTH_CHECK = "health_check"
CMD_SUBSCRIBE_EVENTS = "subscribe_events"

# Claude Code OAuth 명령 — soul-server protocol.py와 mirror
CMD_CLAUDE_AUTH_STATUS = "claude_auth_status"
CMD_CLAUDE_AUTH_SET_TOKEN = "claude_auth_set_token"
CMD_CLAUDE_AUTH_DELETE_TOKEN = "claude_auth_delete_token"
CMD_CLAUDE_AUTH_GET_USAGE = "claude_auth_get_usage"
CMD_CLAUDE_AUTH_GET_PROFILE = "claude_auth_get_profile"  # 계정 프로필(email 등) 조회

# Events (node -> soulstream-server)
EVT_NODE_REGISTER = "node_register"
EVT_SESSION_CREATED = "session_created"
EVT_EVENT = "event"
EVT_SESSIONS_UPDATE = "sessions_update"
EVT_SESSION_UPDATED = "session_updated"
EVT_SESSION_DELETED = "session_deleted"
EVT_HEALTH_STATUS = "health_status"
EVT_ERROR = "error"

# WebSocket Close Codes
WS_CLOSE_REGISTRATION_TIMEOUT = 4001
WS_CLOSE_NODE_ID_REQUIRED = 4002
WS_CLOSE_INVALID_FIRST_MSG = 4003
WS_CLOSE_INVALID_JSON = 4004
WS_CLOSE_CONFIG_ERROR = 4005    # 서버 인증 미구성 (프로덕션 AUTH_BEARER_TOKEN 누락)
WS_CLOSE_AUTH_REQUIRED = 4401   # HTTP 401 미러링 (헤더 누락/형식 오류)
WS_CLOSE_AUTH_INVALID = 4403    # HTTP 403 미러링 (토큰 불일치)

# Registration timeout (seconds)
REGISTRATION_TIMEOUT = 10

# Command timeout (seconds)
COMMAND_TIMEOUT = 30

# Known SSE event types
KNOWN_SSE_EVENT_TYPES = frozenset({
    "init", "reconnected",
    "progress", "memory", "session", "intervention_sent", "user_message",
    "assistant_message", "input_request", "input_request_expired",
    "input_request_responded", "debug", "complete", "error",
    "thinking", "text_start", "text_delta", "text_end",
    "tool_start", "tool_result", "result",
    "subagent_start", "subagent_stop",
    "context_usage", "compact", "reconnect", "history_sync",
    "metadata_updated",
})
