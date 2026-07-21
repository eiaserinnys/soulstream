"""schema 자체 유효성 + 메시지 인벤토리 검증.

본 테스트는 src/upstream.schema.json이 JSON Schema Draft 2020-12 유효이며,
설계 명세에 합의된 111개 $defs (wire 53 + SSE event 58)를 모두 포함하는지 확인한다.
"""

import json
from pathlib import Path

import jsonschema

SCHEMA_PATH = Path(__file__).parent.parent / "src" / "upstream.schema.json"
README_PATH = Path(__file__).parent.parent / "src" / "README.md"
GENERATED_TS_PATH = (
    Path(__file__).parent.parent / "generated" / "typescript" / "index.ts"
)
GENERATED_PY_PATH = Path(__file__).parent.parent / "generated" / "python" / "upstream.py"


def _load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _message_inventory_summary(schema: dict) -> str:
    defs_count = len(schema["$defs"])
    wire_count = len(schema["oneOf"])
    sse_count = defs_count - wire_count
    return f"{defs_count}개 $defs (wire {wire_count} + SSE event {sse_count})"


def test_schema_is_valid_draft_2020_12() -> None:
    schema = _load_schema()
    # check_schema는 위반 시 SchemaError를 raise한다.
    jsonschema.Draft202012Validator.check_schema(schema)


def test_schema_top_level_keys() -> None:
    schema = _load_schema()
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert "$defs" in schema
    assert "oneOf" in schema
    assert schema["discriminator"]["propertyName"] == "type"


def test_schema_has_all_message_types() -> None:
    schema = _load_schema()
    defs = schema["$defs"]

    wire_types = {
        "NodeRegister",
        "AppHeartbeatPing",
        "AppHeartbeatPong",
        "SessionCreated",
        "SessionEventEnvelope",
        "SessionsUpdate",
        "HealthStatus",
        "SessionUpdated",
        "SessionDeleted",
        "ErrorMessage",
        "InterveneAck",
        "InterruptSessionAck",
        "RespondAck",
        "ToolApprovalAck",
        "RealtimeCallCreated",
        "RealtimeEventAck",
        "RealtimeToolApprovalAck",
        "UploadAttachmentResult",
        "UploadAttachmentStartAck",
        "UploadAttachmentChunkAck",
        "UploadAttachmentAbortAck",
        "DeleteSessionAttachmentsResult",
        "DownloadAttachmentResult",
        "CreateSession",
        "Intervene",
        "InterruptSession",
        "Respond",
        "ApproveTool",
        "RejectTool",
        "RealtimeCreateCall",
        "RealtimeEvent",
        "RealtimeResolveToolApproval",
        "ListSessions",
        "UploadAttachment",
        "UploadAttachmentStart",
        "UploadAttachmentChunk",
        "UploadAttachmentFinish",
        "UploadAttachmentAbort",
        "DeleteSessionAttachments",
        "DownloadAttachment",
        "PlanAgentProfileUpdate",
        "ApplyAgentProfileUpdate",
        "ListAgentsConfigSnapshots",
        "RollbackAgentsConfig",
        "HealthCheck",
        "SubscribeEvents",
        "ClaudeAuthStatus",
        "ClaudeAuthSetToken",
        "ClaudeAuthDeleteToken",
        "ClaudeAuthGetUsage",
        "ClaudeAuthGetProfile",
        "AcknowledgeSessionReview",
        "AcknowledgeSessionReviewAck",
    }
    assert len(wire_types) == 53

    sse_types = {
        "SSEEventInit",
        "SSEEventReconnected",
        "SSEEventProgress",
        "SSEEventMemory",
        "SSEEventSession",
        "SSEEventInterventionSent",
        "SSEEventUserMessage",
        "SSEEventAssistantMessage",
        "SSEEventInputRequest",
        "SSEEventInputRequestExpired",
        "SSEEventInputRequestResponded",
        "SSEEventDebug",
        "SSEEventComplete",
        "SSEEventError",
        "SSEEventCredentialAlert",
        "SSEEventSessionEnded",
        "SSEEventThinking",
        "SSEEventTextStart",
        "SSEEventTextDelta",
        "SSEEventTextEnd",
        "SSEEventToolStart",
        "SSEEventToolResult",
        "SSEEventAgentUpdated",
        "SSEEventHandoffRequested",
        "SSEEventHandoffOccurred",
        "SSEEventToolApprovalRequested",
        "SSEEventToolApprovalResolved",
        "SSEEventGuardrailTripwire",
        "SSEEventRealtimeStatus",
        "SSEEventRealtimeTranscript",
        "SSEEventResult",
        "SSEEventPromptSuggestion",
        "SSEEventSubagentStart",
        "SSEEventSubagentStop",
        "SSEEventClaudeRuntimeSessionState",
        "SSEEventClaudeRuntimeTaskStarted",
        "SSEEventClaudeRuntimeTaskCreated",
        "SSEEventClaudeRuntimeTaskUpdated",
        "SSEEventClaudeRuntimeTaskProgress",
        "SSEEventClaudeRuntimeTaskCompleted",
        "SSEEventClaudeRuntimeTaskNotification",
        "SSEEventClaudeRuntimeNotification",
        "SSEEventClaudeRuntimeRemoteTrigger",
        "SSEEventClaudeRuntimeTranscriptMirrorError",
        "SSEEventClaudeRuntimeHookEvent",
        "SSEEventClaudeRuntimeModeState",
        "SSEEventClaudeRuntimeScheduleUpdated",
        "SSEEventClaudeRuntimeScheduleDeleted",
        "SSEEventTaskUpdated",
        "SSEEventRunbookUpdatedLegacy",
        "SSEEventCustomViewUpdated",
        "SSEEventContextUsage",
        "SSEEventCompact",
        "SSEEventReconnect",
        "SSEEventHistorySync",
        "SSEEventMetadataUpdated",
        "SSEEventAssistantError",
        "SSEEventAwaySummary",
    }
    assert len(sse_types) == 58, (
        "SSE event $defs 58종 (canonical 57종 + production-gated runbook_updated 읽기 호환)."
    )

    expected = wire_types | sse_types
    missing = expected - set(defs.keys())
    assert not missing, f"Missing $defs: {sorted(missing)}"


def test_documented_message_inventory_counts_match_schema() -> None:
    schema = _load_schema()
    expected = _message_inventory_summary(schema)

    assert expected in README_PATH.read_text(encoding="utf-8")
    assert expected in GENERATED_TS_PATH.read_text(encoding="utf-8")
    assert expected in GENERATED_PY_PATH.read_text(encoding="utf-8")


def test_session_binding_warnings_are_additive_on_created_and_reconnect_rows() -> None:
    schema = _load_schema()
    created = schema["$defs"]["SessionCreated"]["properties"]["session"]["properties"]
    reconnect = schema["$defs"]["SessionsUpdate"]["properties"]["sessions"]["items"]["properties"]
    for properties in (created, reconnect):
        warning = properties["binding_warnings"]
        assert warning["type"] == "array"
        assert warning["items"]["required"] == ["code", "message"]
        assert warning["items"]["properties"]["code"]["enum"] == [
            "PAGE_BINDING_PENDING",
            "PAGE_BINDING_MANUAL_REPAIR",
            "LEGACY_PROJECTION_PENDING",
        ]


def test_node_register_has_supported_backends() -> None:
    """옵션 D Phase A — NodeRegister에 supported_backends 신규 필드가 박혀 있어야 한다."""
    schema = _load_schema()
    node_register = schema["$defs"]["NodeRegister"]
    props = node_register["properties"]
    assert "supported_backends" in props
    assert props["supported_backends"]["type"] == "array"
    assert props["supported_backends"]["items"] == {"type": "string"}
    assert props["supported_backends"]["default"] == ["claude"]


def test_node_register_has_app_heartbeat_capability_contract() -> None:
    schema = _load_schema()
    node_register = schema["$defs"]["NodeRegister"]
    capabilities = node_register["properties"]["capabilities"]
    assert capabilities["additionalProperties"] is True
    assert "app_heartbeat_v1" in capabilities["description"]


def test_app_heartbeat_messages_are_symmetric() -> None:
    schema = _load_schema()
    ping = schema["$defs"]["AppHeartbeatPing"]
    pong = schema["$defs"]["AppHeartbeatPong"]
    assert ping["properties"]["type"] == {"const": "app_heartbeat_ping"}
    assert pong["properties"]["type"] == {"const": "app_heartbeat_pong"}
    assert ping["properties"]["sentAt"]["type"] == "string"
    assert pong["properties"]["sentAt"]["type"] == "string"


def test_create_session_has_reasoning_effort() -> None:
    schema = _load_schema()
    create_session = schema["$defs"]["CreateSession"]
    prop = create_session["properties"]["reasoningEffort"]
    assert prop["type"] == "string"
    assert prop["enum"] == ["minimal", "low", "medium", "high", "xhigh"]


def test_intervene_has_extra_context_items() -> None:
    schema = _load_schema()
    intervene = schema["$defs"]["Intervene"]
    prop = intervene["properties"]["extra_context_items"]
    assert prop["type"] == "array"
    assert prop["items"]["type"] == "object"


def test_interrupt_session_ack_exposes_explicit_failure_contract() -> None:
    schema = _load_schema()
    ack = schema["$defs"]["InterruptSessionAck"]
    assert ack["properties"]["status"]["enum"] == ["ok", "error"]
    assert ack["properties"]["code"]["type"] == "string"
    assert ack["properties"]["message"]["type"] == "string"


def test_oneof_covers_all_wire_messages() -> None:
    schema = _load_schema()
    oneof_refs = {entry["$ref"].rsplit("/", 1)[-1] for entry in schema["oneOf"]}
    wire_types = {
        "NodeRegister",
        "AppHeartbeatPing",
        "AppHeartbeatPong",
        "SessionCreated",
        "SessionEventEnvelope",
        "SessionsUpdate",
        "HealthStatus",
        "SessionUpdated",
        "SessionDeleted",
        "ErrorMessage",
        "InterveneAck",
        "InterruptSessionAck",
        "RespondAck",
        "ToolApprovalAck",
        "RealtimeCallCreated",
        "RealtimeEventAck",
        "RealtimeToolApprovalAck",
        "UploadAttachmentResult",
        "UploadAttachmentStartAck",
        "UploadAttachmentChunkAck",
        "UploadAttachmentAbortAck",
        "DeleteSessionAttachmentsResult",
        "DownloadAttachmentResult",
        "CreateSession",
        "Intervene",
        "InterruptSession",
        "Respond",
        "ApproveTool",
        "RejectTool",
        "RealtimeCreateCall",
        "RealtimeEvent",
        "RealtimeResolveToolApproval",
        "ListSessions",
        "UploadAttachment",
        "UploadAttachmentStart",
        "UploadAttachmentChunk",
        "UploadAttachmentFinish",
        "UploadAttachmentAbort",
        "DeleteSessionAttachments",
        "DownloadAttachment",
        "PlanAgentProfileUpdate",
        "ApplyAgentProfileUpdate",
        "ListAgentsConfigSnapshots",
        "RollbackAgentsConfig",
        "HealthCheck",
        "SubscribeEvents",
        "ClaudeAuthStatus",
        "ClaudeAuthSetToken",
        "ClaudeAuthDeleteToken",
        "ClaudeAuthGetUsage",
        "ClaudeAuthGetProfile",
        "AcknowledgeSessionReview",
        "AcknowledgeSessionReviewAck",
    }
    assert oneof_refs == wire_types


def test_plan_agent_profile_update_is_read_only_command() -> None:
    schema = _load_schema()
    command = schema["$defs"]["PlanAgentProfileUpdate"]
    assert command["properties"]["type"]["const"] == "plan_agent_profile_update"
    assert "profile" in command["required"]
    props = command["properties"]
    assert "snapshot_path" not in props
    assert props["include_text_diff"]["default"] is False
    assert props["includeTextDiff"]["default"] is False
    assert "semantic_changes" in props
    assert props["semantic_changes"]["items"]["properties"]["op"]["enum"] == [
        "add_agent",
        "replace_agent",
        "update_agent_atom_contexts",
        "no_change",
    ]
    assert props["text_diff_included"]["type"] == "boolean"
    assert props["comment_preservation"]["enum"] == ["not_preserved"]


def test_known_sse_event_types_completeness() -> None:
    """orch-server/constants.py KNOWN_SSE_EVENT_TYPES와 schema SSE $defs의 type const가 일치해야 한다."""
    schema = _load_schema()
    sse_consts = set()
    for name, body in schema["$defs"].items():
        if not name.startswith("SSEEvent"):
            continue
        sse_consts.add(body["properties"]["type"]["const"])

    expected_known = {
        "init",
        "reconnected",
        "progress",
        "memory",
        "session",
        "intervention_sent",
        "user_message",
        "assistant_message",
        "input_request",
        "input_request_expired",
        "input_request_responded",
        "debug",
        "complete",
        "error",
        "credential_alert",
        "session_ended",
        "thinking",
        "text_start",
        "text_delta",
        "text_end",
        "tool_start",
        "tool_result",
        "agent_updated",
        "handoff_requested",
        "handoff_occurred",
        "tool_approval_requested",
        "tool_approval_resolved",
        "guardrail_tripwire",
        "realtime_status",
        "realtime_transcript",
        "result",
        "prompt_suggestion",
        "subagent_start",
        "subagent_stop",
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
            "runbook_updated",
        "custom_view_updated",
        "context_usage",
        "compact",
        "reconnect",
        "history_sync",
        "metadata_updated",
        "assistant_error",
        "away_summary",
    }
    assert sse_consts == expected_known, (
        f"Missing: {expected_known - sse_consts}, Extra: {sse_consts - expected_known}"
    )
