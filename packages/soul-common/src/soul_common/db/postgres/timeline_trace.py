"""Timeline compact summary and tool trace helpers."""

from __future__ import annotations

import json
from datetime import datetime

TOOL_TRACE_PREFIX = "tool:"
TOOL_INPUT_PREVIEW_CHARS = 100
TOOL_RESULT_PREVIEW_CHARS = 300


def payload_dict(payload) -> dict:
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    if isinstance(payload, dict):
        return payload
    return {}


def serialize_message_rows(rows) -> list[dict]:
    messages = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()
        d["payload"] = payload_dict(d.get("payload"))
        messages.append(d)
    return messages


def serialize_timeline_rows(rows) -> list[dict]:
    starts: dict[str, tuple[dict, dict]] = {}
    results: dict[str, tuple[dict, dict]] = {}
    payloads_by_id: dict[int, dict] = {}

    for row in rows:
        payload = payload_dict(row["payload"])
        payloads_by_id[int(row["id"])] = payload
        tool_id = tool_use_id(payload)
        if not tool_id:
            continue
        if row["event_type"] == "tool_start" and tool_id not in starts:
            starts[tool_id] = (payload, row)
        elif row["event_type"] == "tool_result" and tool_id not in results:
            results[tool_id] = (payload, row)

    messages = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("created_at"), datetime):
            d["created_at"] = d["created_at"].isoformat()

        payload = payloads_by_id.get(int(r["id"]), payload_dict(d.get("payload")))
        tool_id = tool_use_id(payload)
        if r["event_type"] == "tool_start" and tool_id:
            result_pair = results.get(tool_id)
            d["payload"] = compact_tool_start_payload(
                payload, r,
                result_pair[0] if result_pair else None,
                result_pair[1] if result_pair else None,
            )
        elif r["event_type"] == "tool_result" and tool_id:
            start_pair = starts.get(tool_id)
            d["payload"] = compact_tool_result_payload(
                payload, r,
                start_pair[0] if start_pair else None,
                start_pair[1] if start_pair else None,
            )
        else:
            d["payload"] = payload
        messages.append(d)
    return messages


def timeline_tool_use_ids(rows) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if row["event_type"] != "tool_result":
            continue
        payload = payload_dict(row["payload"])
        tool_id = tool_use_id(payload)
        if tool_id and tool_id not in seen:
            seen.add(tool_id)
            ids.append(tool_id)
    return ids


def build_tool_trace(
    timeline_id: str,
    tool_id: str,
    rows: list[dict],
) -> dict:
    events = serialize_message_rows(rows)
    start_event = next((e for e in events if e["event_type"] == "tool_start"), None)
    result_event = next(
        (e for e in reversed(events) if e["event_type"] == "tool_result"), None,
    )
    progress_events = [
        e for e in events
        if e["event_type"] in ("progress", "debug", "system", "system_message")
    ]

    start_payload = start_event["payload"] if start_event else {}
    result_payload = result_event["payload"] if result_event else {}
    started_at = event_timestamp(start_payload, start_event or {}) if start_event else None
    completed_at = (
        event_timestamp(result_payload, result_event or {}) if result_event else None
    )
    is_error = bool(result_payload.get("is_error")) if result_payload else False

    return {
        "type": "tool_trace",
        "timeline_id": timeline_id,
        "tool_use_id": tool_id,
        "tool_name": (
            start_payload.get("tool_name")
            or result_payload.get("tool_name")
            or start_payload.get("name")
            or ""
        ),
        "status": "error" if is_error else "completed" if result_event else "running",
        "is_error": is_error,
        "started_at": started_at,
        "completed_at": completed_at,
        "duration_ms": duration_ms(started_at, completed_at),
        "input": start_payload.get("tool_input") or start_payload.get("input"),
        "result": (
            result_payload.get("result")
            or result_payload.get("content")
            or result_payload.get("output")
        ),
        "progress": progress_events,
        "events": events,
    }


def tool_timeline_id(tool_id: str) -> str:
    return f"{TOOL_TRACE_PREFIX}{tool_id}"


def trace_tool_use_id(timeline_id: str) -> str | None:
    if timeline_id.startswith(TOOL_TRACE_PREFIX):
        value = timeline_id[len(TOOL_TRACE_PREFIX):]
        return value or None
    return timeline_id or None


def tool_use_id(payload: dict) -> str | None:
    value = payload.get("tool_use_id")
    return value if isinstance(value, str) and value else None


def compact_tool_start_payload(
    payload: dict,
    row: dict,
    result_payload: dict | None,
    result_row: dict | None,
) -> dict:
    tool_id = tool_use_id(payload)
    if not tool_id:
        return payload

    input_preview, input_truncated = compact_preview(
        payload.get("tool_input") or payload.get("input"), TOOL_INPUT_PREVIEW_CHARS,
    )
    started_at = event_timestamp(payload, row)
    completed_at = (
        event_timestamp(result_payload, result_row)
        if result_payload is not None and result_row is not None else None
    )
    is_error = bool(result_payload.get("is_error")) if result_payload else False
    status = "error" if is_error else "completed" if result_payload else "running"

    compact = base_tool_payload(payload, row, tool_id)
    compact.update({
        "tool_input": input_preview,
        "tool_input_preview": input_preview,
        "tool_input_truncated": input_truncated,
        "status": status,
        "started_at": started_at,
        "completed_at": completed_at,
        "duration_ms": duration_ms(started_at, completed_at),
        **({"timestamp": payload["timestamp"]} if "timestamp" in payload else {}),
    })
    return compact


def compact_tool_result_payload(
    payload: dict,
    row: dict,
    start_payload: dict | None,
    start_row: dict | None,
) -> dict:
    tool_id = tool_use_id(payload)
    if not tool_id:
        return payload

    result_preview, result_truncated = compact_preview(
        payload.get("result") or payload.get("content") or payload.get("output"),
        TOOL_RESULT_PREVIEW_CHARS,
    )
    started_at = (
        event_timestamp(start_payload, start_row)
        if start_payload is not None and start_row is not None else None
    )
    completed_at = event_timestamp(payload, row)
    is_error = bool(payload.get("is_error"))

    compact = base_tool_payload(payload, row, tool_id)
    compact.update({
        "result": result_preview,
        "result_preview": result_preview,
        "result_truncated": result_truncated,
        "is_error": is_error,
        "status": "error" if is_error else "completed",
        "started_at": started_at,
        "completed_at": completed_at,
        "duration_ms": duration_ms(started_at, completed_at),
        **({"timestamp": payload["timestamp"]} if "timestamp" in payload else {}),
    })
    return compact


def base_tool_payload(payload: dict, row: dict, tool_id: str) -> dict:
    return {
        "type": payload.get("type") or row["event_type"],
        "tool_name": payload.get("tool_name") or payload.get("name") or "",
        "tool_use_id": tool_id,
        "timeline_id": tool_timeline_id(tool_id),
        "has_trace": True,
        "source_event_id": int(row["id"]),
        "trace_cursor": f"event:{int(row['id'])}",
        **(
            {"parent_event_id": payload["parent_event_id"]}
            if payload.get("parent_event_id") is not None else {}
        ),
    }


def compact_preview(value, limit: int) -> tuple[str, bool]:
    text = content_to_text(value).replace("\r\n", "\n").strip()
    text = " ".join(text.split())
    if len(text) <= limit:
        return text, False
    return text[:limit].rstrip() + "…", True


def content_to_text(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts) if parts else json_preview(value)
    if isinstance(value, dict):
        for key in ("command", "cmd", "input", "query", "pattern", "path"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
        return "" if not value else json_preview(value)
    if value is None:
        return ""
    return str(value)


def json_preview(value) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def event_timestamp(payload: dict, row: dict) -> float | None:
    value = payload.get("timestamp")
    if isinstance(value, (int, float)):
        return float(value)
    created_at = row.get("created_at")
    if isinstance(created_at, datetime):
        return created_at.timestamp()
    return None


def duration_ms(started_at: float | None, completed_at: float | None) -> int | None:
    if started_at is None or completed_at is None:
        return None
    return max(0, round((completed_at - started_at) * 1000))
