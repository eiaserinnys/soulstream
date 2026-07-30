"""
프로토콜 상수 — soul-server UpstreamAdapter와 호환.
"""

# Commands (soulstream-server -> node)
CMD_CREATE_SESSION = "create_session"
CMD_INTERVENE = "intervene"
CMD_INTERRUPT_SESSION = "interrupt_session"
CMD_RESPOND = "respond"
CMD_CLAUDE_RUNTIME_LIST_TASKS = "claude_runtime_list_tasks"
CMD_CLAUDE_RUNTIME_TASK_OUTPUT = "claude_runtime_task_output"
CMD_CLAUDE_RUNTIME_STOP_TASK = "claude_runtime_stop_task"
CMD_CLAUDE_RUNTIME_BACKGROUND_TASKS = "claude_runtime_background_tasks"
CMD_CLAUDE_RUNTIME_LIST_SCHEDULES = "claude_runtime_list_schedules"
CMD_CLAUDE_RUNTIME_DELETE_SCHEDULE = "claude_runtime_delete_schedule"
CMD_APPROVE_TOOL = "approve_tool"
CMD_REJECT_TOOL = "reject_tool"
CMD_REALTIME_CREATE_CALL = "realtime_create_call"
CMD_REALTIME_EVENT = "realtime_event"
CMD_REALTIME_RESOLVE_TOOL_APPROVAL = "realtime_resolve_tool_approval"
CMD_LIST_SESSIONS = "list_sessions"
CMD_HEALTH_CHECK = "health_check"
CMD_SUBSCRIBE_EVENTS = "subscribe_events"

# Attachment WS reverse-proxy commands — soul-server protocol.py와 mirror.
# 노드 self-reported host:port HTTP 가정 폐기 — 신뢰 가능한 WS wire로 통합.
# atom 작업 이력 260513.01.
CMD_UPLOAD_ATTACHMENT = "upload_attachment"
CMD_UPLOAD_ATTACHMENT_START = "upload_attachment_start"
CMD_UPLOAD_ATTACHMENT_CHUNK = "upload_attachment_chunk"
CMD_UPLOAD_ATTACHMENT_FINISH = "upload_attachment_finish"
CMD_UPLOAD_ATTACHMENT_ABORT = "upload_attachment_abort"
CMD_DELETE_SESSION_ATTACHMENTS = "delete_session_attachments"
# atom 작업 이력 260513.02 (chat-inline-attachment) — 채팅 인라인 표시.
CMD_DOWNLOAD_ATTACHMENT = "download_attachment"

# Claude Code OAuth 명령 — soul-server protocol.py와 mirror
CMD_CLAUDE_AUTH_STATUS = "claude_auth_status"
CMD_CLAUDE_AUTH_SET_TOKEN = "claude_auth_set_token"
CMD_CLAUDE_AUTH_DELETE_TOKEN = "claude_auth_delete_token"
CMD_CLAUDE_AUTH_GET_USAGE = "claude_auth_get_usage"
CMD_CLAUDE_AUTH_GET_PROFILE = "claude_auth_get_profile"  # 계정 프로필(email 등) 조회
CMD_PROVIDER_USAGE_GET = "provider_usage_get"
CMD_REFLECT_BRIEF = "reflect_brief"
CMD_PLAN_AGENT_PROFILE_UPDATE = "plan_agent_profile_update"
CMD_APPLY_AGENT_PROFILE_UPDATE = "apply_agent_profile_update"
CMD_LIST_AGENTS_CONFIG_SNAPSHOTS = "list_agents_config_snapshots"
CMD_ROLLBACK_AGENTS_CONFIG = "rollback_agents_config"

# Events (node -> soulstream-server)
EVT_NODE_REGISTER = "node_register"
EVT_APP_HEARTBEAT_PING = "app_heartbeat_ping"
EVT_APP_HEARTBEAT_PONG = "app_heartbeat_pong"
EVT_SESSION_CREATED = "session_created"
EVT_EVENT = "event"
EVT_SESSIONS_UPDATE = "sessions_update"
EVT_SESSION_UPDATED = "session_updated"
EVT_SESSION_DELETED = "session_deleted"
EVT_HEALTH_STATUS = "health_status"
EVT_ERROR = "error"
# 빌드 20: input_request도 worker→orch ws에서 별도 메시지 타입으로 forwarding하여
# PushNotifier가 수신할 수 있게 한다. soul-server adapter._dispatch_broadcast_event에서
# 'input_request' broadcast를 이 타입으로 변환하여 보내고, orch node_connection이 받아
# on_session_change(node_id, "input_request", data)로 정규화한다.
EVT_INPUT_REQUEST = "input_request"

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

# App-level node WebSocket heartbeat.
CAP_APP_HEARTBEAT_V1 = "app_heartbeat_v1"
APP_HEARTBEAT_INTERVAL = 10.0
APP_HEARTBEAT_MAX_MISSED = 2

# Attachment limits.
# 100MB is the user-facing single attachment limit. Upload transport uses
# bounded chunks over the existing outbound node WebSocket, so this limit no
# longer needs to fit inside one WS text frame.
MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024
LEGACY_ATTACHMENT_MAX_SIZE = 8 * 1024 * 1024
ATTACHMENT_UPLOAD_CHUNK_SIZE = 1024 * 1024

# Known SSE event types
KNOWN_SSE_EVENT_TYPES = frozenset({
    "init", "reconnected",
    "progress", "memory", "session", "intervention_sent", "user_message",
    "assistant_message", "input_request", "input_request_expired",
    "input_request_responded", "debug", "complete", "error",
    "credential_alert", "session_ended", "thinking", "text_start", "text_delta", "text_end",
    "tool_start", "tool_result", "result", "prompt_suggestion",
    "agent_updated", "handoff_requested", "handoff_occurred",
    "tool_approval_requested", "tool_approval_resolved",
    "guardrail_tripwire",
    "realtime_status", "realtime_transcript",
    "subagent_start", "subagent_stop",
    "claude_runtime_session_state",
    "claude_runtime_task_started",
    "claude_runtime_task_created",
    "claude_runtime_task_updated",
    "claude_runtime_task_progress",
    "claude_runtime_task_completed",
    "claude_runtime_task_notification",
    "claude_runtime_notification",
    "claude_runtime_remote_trigger",
    "claude_runtime_transcript_mirror_error",
    "claude_runtime_hook_event",
    "claude_runtime_mode_state",
    "claude_runtime_schedule_updated",
    "claude_runtime_schedule_deleted",
    "task_updated",
    "custom_view_updated",
    "context_usage", "compact", "reconnect", "history_sync",
    "metadata_updated", "assistant_error", "away_summary",
})
