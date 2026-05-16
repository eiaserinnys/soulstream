"""schema 자체 유효성 + 메시지 인벤토리 검증.

본 테스트는 src/upstream.schema.json이 JSON Schema Draft 2020-12 유효이며,
설계 명세에 합의된 47개 $defs (wire 20 + SSE event 27)를 모두 포함하는지 확인한다.
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
        "CreateSession",
        "Intervene",
        "Respond",
        "ListSessions",
        "HealthCheck",
        "SubscribeEvents",
        "ClaudeAuthStatus",
        "ClaudeAuthSetToken",
        "ClaudeAuthDeleteToken",
        "ClaudeAuthGetUsage",
        "ClaudeAuthGetProfile",
    }
    assert len(wire_types) == 20

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
        "SSEEventThinking",
        "SSEEventTextStart",
        "SSEEventTextDelta",
        "SSEEventTextEnd",
        "SSEEventToolStart",
        "SSEEventToolResult",
        "SSEEventResult",
        "SSEEventSubagentStart",
        "SSEEventSubagentStop",
        "SSEEventContextUsage",
        "SSEEventCompact",
        "SSEEventReconnect",
        "SSEEventHistorySync",
        "SSEEventMetadataUpdated",
    }
    assert len(sse_types) == 28, (
        "SSE event $defs 28종 (orch-server/constants.py KNOWN_SSE_EVENT_TYPES L60-69 그대로)."
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
        "CreateSession",
        "Intervene",
        "Respond",
        "ListSessions",
        "HealthCheck",
        "SubscribeEvents",
        "ClaudeAuthStatus",
        "ClaudeAuthSetToken",
        "ClaudeAuthDeleteToken",
        "ClaudeAuthGetUsage",
        "ClaudeAuthGetProfile",
    }
    assert oneof_refs == wire_types


def test_known_sse_event_types_completeness() -> None:
    """orch-server/constants.py KNOWN_SSE_EVENT_TYPES 27개와 schema SSE $defs의 type const가 일치해야 한다."""
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
        "thinking",
        "text_start",
        "text_delta",
        "text_end",
        "tool_start",
        "tool_result",
        "result",
        "subagent_start",
        "subagent_stop",
        "context_usage",
        "compact",
        "reconnect",
        "history_sync",
        "metadata_updated",
    }
    assert sse_consts == expected_known, (
        f"Missing: {expected_known - sse_consts}, Extra: {sse_consts - expected_known}"
    )
