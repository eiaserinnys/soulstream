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
