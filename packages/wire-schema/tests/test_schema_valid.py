"""schema 자체 유효성 + 메시지 인벤토리 검증.

본 테스트는 src/upstream.schema.json이 JSON Schema Draft 2020-12 유효이며,
설계 명세에 합의된 73개 $defs (wire 33 + SSE event 40)를 모두 포함하는지 확인한다.
"""

import json
from pathlib import Path

import jsonschema

SCHEMA_PATH = Path(__file__).parent.parent / "src" / "upstream.schema.json"


def _load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


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
    }
    assert len(wire_types) == 36

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
        "SSEEventClaudeRuntimeTaskUpdated",
        "SSEEventClaudeRuntimeTaskProgress",
        "SSEEventClaudeRuntimeTaskNotification",
        "SSEEventContextUsage",
        "SSEEventCompact",
        "SSEEventReconnect",
        "SSEEventHistorySync",
        "SSEEventMetadataUpdated",
        "SSEEventAssistantError",
        "SSEEventAwaySummary",
    }
    assert len(sse_types) == 45, (
        "SSE event $defs 45종 (orch-server/constants.py KNOWN_SSE_EVENT_TYPES + Agents SDK events)."
    )

    expected = wire_types | sse_types
    missing = expected - set(defs.keys())
    assert not missing, f"Missing $defs: {sorted(missing)}"


def test_node_register_has_supported_backends() -> None:
    """옵션 D Phase A — NodeRegister에 supported_backends 신규 필드가 박혀 있어야 한다."""
    schema = _load_schema()
    node_register = schema["$defs"]["NodeRegister"]
    props = node_register["properties"]
    assert "supported_backends" in props
    assert props["supported_backends"]["type"] == "array"
    assert props["supported_backends"]["items"] == {"type": "string"}
    assert props["supported_backends"]["default"] == ["claude"]


def test_create_session_has_reasoning_effort() -> None:
    schema = _load_schema()
    create_session = schema["$defs"]["CreateSession"]
    prop = create_session["properties"]["reasoningEffort"]
    assert prop["type"] == "string"
    assert prop["enum"] == ["minimal", "low", "medium", "high", "xhigh"]


def test_oneof_covers_all_wire_messages() -> None:
    schema = _load_schema()
    oneof_refs = {entry["$ref"].rsplit("/", 1)[-1] for entry in schema["oneOf"]}
    wire_types = {
        "NodeRegister",
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
        "claude_runtime_task_updated",
        "claude_runtime_task_progress",
        "claude_runtime_task_notification",
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
