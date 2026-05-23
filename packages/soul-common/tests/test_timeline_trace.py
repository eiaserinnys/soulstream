from datetime import datetime, timezone
import importlib.util
from pathlib import Path

_MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "soul_common"
    / "db"
    / "postgres"
    / "timeline_trace.py"
)
_SPEC = importlib.util.spec_from_file_location("timeline_trace", _MODULE_PATH)
assert _SPEC and _SPEC.loader
timeline_trace = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(timeline_trace)
serialize_timeline_rows = timeline_trace.serialize_timeline_rows


def _row(event_id: int, event_type: str, payload: dict) -> dict:
    return {
        "id": event_id,
        "parent_event_id": None,
        "event_type": event_type,
        "payload": payload,
        "created_at": datetime(2026, 5, 24, 0, 0, event_id, tzinfo=timezone.utc),
    }


def test_tool_start_compact_payload_keeps_timeline_event_type_for_running_tool():
    rows = [
        _row(
            1,
            "tool_start",
            {
                "type": "tool_use",
                "tool_use_id": "toolu_1",
                "name": "Bash",
                "input": {"command": "pnpm test"},
            },
        ),
    ]

    [message] = serialize_timeline_rows(rows)

    assert message["event_type"] == "tool_start"
    assert message["payload"]["type"] == "tool_start"
    assert message["payload"]["tool_use_id"] == "toolu_1"
    assert message["payload"]["tool_name"] == "Bash"
    assert message["payload"]["tool_input_preview"] == "pnpm test"
    assert message["payload"]["status"] == "running"


def test_tool_start_compact_payload_is_completed_when_result_is_in_page():
    rows = [
        _row(
            1,
            "tool_start",
            {
                "type": "tool_use",
                "tool_use_id": "toolu_1",
                "name": "Bash",
                "input": {"command": "pnpm test"},
            },
        ),
        _row(
            2,
            "tool_result",
            {
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "result": "ok",
                "is_error": False,
            },
        ),
    ]

    messages = serialize_timeline_rows(rows)

    assert messages[0]["payload"]["type"] == "tool_start"
    assert messages[0]["payload"]["status"] == "completed"
    assert messages[0]["payload"]["completed_at"] is not None
    assert messages[1]["payload"]["type"] == "tool_result"
    assert messages[1]["payload"]["status"] == "completed"
