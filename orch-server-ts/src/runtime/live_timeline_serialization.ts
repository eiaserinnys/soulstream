import { iso } from "./live_session_serialization.js";

type EventRow = Record<string, unknown>;

const TOOL_TRACE_PREFIX = "tool:";
const TOOL_INPUT_PREVIEW_CHARS = 100;
const TOOL_RESULT_PREVIEW_CHARS = 300;

export function serializeMessageRows(rows: readonly EventRow[]): Record<string, unknown>[] {
  return rows.map((row) => ({
    ...row,
    created_at: iso(row.created_at),
    payload: payloadDict(row.payload),
  }));
}

export function serializeTimelineRows(rows: readonly EventRow[]): Record<string, unknown>[] {
  const starts = new Map<string, { payload: Record<string, unknown>; row: EventRow }>();
  const results = new Map<string, { payload: Record<string, unknown>; row: EventRow }>();
  const payloadsById = new Map<number, Record<string, unknown>>();

  for (const row of rows) {
    const payload = payloadDict(row.payload);
    const id = numberValue(row.id);
    if (id !== null) payloadsById.set(id, payload);
    const toolId = toolUseId(payload);
    if (toolId === null) continue;
    if (row.event_type === "tool_start" && !starts.has(toolId)) {
      starts.set(toolId, { payload, row });
    }
    if (row.event_type === "tool_result" && !results.has(toolId)) {
      results.set(toolId, { payload, row });
    }
  }

  return rows.map((row) => {
    const id = numberValue(row.id);
    const payload = id === null
      ? payloadDict(row.payload)
      : payloadsById.get(id) ?? payloadDict(row.payload);
    const toolId = toolUseId(payload);
    let compact = payload;
    if (row.event_type === "tool_start" && toolId !== null) {
      const pair = results.get(toolId);
      compact = compactToolStartPayload(payload, row, pair?.payload, pair?.row);
    }
    if (row.event_type === "tool_result" && toolId !== null) {
      const pair = starts.get(toolId);
      compact = compactToolResultPayload(payload, row, pair?.payload, pair?.row);
    }
    return {
      ...row,
      created_at: iso(row.created_at),
      payload: compact,
    };
  });
}

export function timelineToolUseIds(rows: readonly EventRow[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.event_type !== "tool_result") continue;
    const id = toolUseId(payloadDict(row.payload));
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function buildToolTrace(
  timelineId: string,
  toolId: string,
  rows: readonly EventRow[],
): Record<string, unknown> {
  const events = serializeMessageRows(rows);
  const startEvent = events.find((event) => event.event_type === "tool_start");
  const resultEvent = [...events].reverse().find(
    (event) => event.event_type === "tool_result",
  );
  const progress = events.filter((event) =>
    ["progress", "debug", "system", "system_message"].includes(
      String(event.event_type),
    ),
  );
  const startPayload = payloadDict(startEvent?.payload);
  const resultPayload = payloadDict(resultEvent?.payload);
  const startedAt =
    startEvent === undefined ? null : eventTimestamp(startPayload, startEvent);
  const completedAt =
    resultEvent === undefined ? null : eventTimestamp(resultPayload, resultEvent);
  const isError = resultPayload.is_error === true;

  return {
    type: "tool_trace",
    timeline_id: timelineId,
    tool_use_id: toolId,
    tool_name:
      stringValue(startPayload.tool_name) ??
      stringValue(resultPayload.tool_name) ??
      stringValue(startPayload.name) ??
      "",
    status: isError ? "error" : resultEvent === undefined ? "running" : "completed",
    is_error: isError,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs(startedAt, completedAt),
    input: startPayload.tool_input ?? startPayload.input,
    result: resultPayload.result ?? resultPayload.content ?? resultPayload.output,
    progress,
    events,
  };
}

export function toolTimelineId(toolId: string): string {
  return `${TOOL_TRACE_PREFIX}${toolId}`;
}

export function traceToolUseId(timelineId: string): string | null {
  if (timelineId.startsWith(TOOL_TRACE_PREFIX)) {
    const value = timelineId.slice(TOOL_TRACE_PREFIX.length);
    return value.length > 0 ? value : null;
  }
  return timelineId.length > 0 ? timelineId : null;
}

function compactToolStartPayload(
  payload: Record<string, unknown>,
  row: EventRow,
  resultPayload: Record<string, unknown> | undefined,
  resultRow: EventRow | undefined,
): Record<string, unknown> {
  const toolId = toolUseId(payload);
  if (toolId === null) return payload;
  const [inputPreview, inputTruncated] = compactPreview(
    payload.tool_input ?? payload.input,
    TOOL_INPUT_PREVIEW_CHARS,
  );
  const startedAt = eventTimestamp(payload, row);
  const completedAt =
    resultPayload === undefined || resultRow === undefined
      ? null
      : eventTimestamp(resultPayload, resultRow);
  const isError = resultPayload?.is_error === true;
  return {
    ...baseToolPayload(payload, row, toolId),
    tool_input: inputPreview,
    tool_input_preview: inputPreview,
    tool_input_truncated: inputTruncated,
    status: isError ? "error" : resultPayload === undefined ? "running" : "completed",
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs(startedAt, completedAt),
    ...(payload.timestamp === undefined ? {} : { timestamp: payload.timestamp }),
  };
}

function compactToolResultPayload(
  payload: Record<string, unknown>,
  row: EventRow,
  startPayload: Record<string, unknown> | undefined,
  startRow: EventRow | undefined,
): Record<string, unknown> {
  const toolId = toolUseId(payload);
  if (toolId === null) return payload;
  const [resultPreview, resultTruncated] = compactPreview(
    payload.result ?? payload.content ?? payload.output,
    TOOL_RESULT_PREVIEW_CHARS,
  );
  const startedAt =
    startPayload === undefined || startRow === undefined
      ? null
      : eventTimestamp(startPayload, startRow);
  const completedAt = eventTimestamp(payload, row);
  const isError = payload.is_error === true;
  return {
    ...baseToolPayload(payload, row, toolId),
    result: resultPreview,
    result_preview: resultPreview,
    result_truncated: resultTruncated,
    is_error: isError,
    status: isError ? "error" : "completed",
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs(startedAt, completedAt),
    ...(payload.timestamp === undefined ? {} : { timestamp: payload.timestamp }),
  };
}

function baseToolPayload(
  payload: Record<string, unknown>,
  row: EventRow,
  toolId: string,
): Record<string, unknown> {
  return {
    type: row.event_type,
    tool_name: stringValue(payload.tool_name) ?? stringValue(payload.name) ?? "",
    tool_use_id: toolId,
    timeline_id: toolTimelineId(toolId),
    has_trace: true,
    source_event_id: numberValue(row.id),
    trace_cursor: `event:${numberValue(row.id) ?? ""}`,
    ...(payload.parent_event_id === undefined
      ? {}
      : { parent_event_id: payload.parent_event_id }),
  };
}

function payloadDict(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as unknown;
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(payload) ?? {};
}

function toolUseId(payload: Record<string, unknown>): string | null {
  return stringValue(payload.tool_use_id);
}

function compactPreview(value: unknown, limit: number): [string, boolean] {
  const text = contentToText(value).replace(/\r\n/g, "\n").trim().split(/\s+/).join(" ");
  if (text.length <= limit) return [text, false];
  return [`${text.slice(0, limit).trimEnd()}...`, true];
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      if (typeof item === "string") return [item];
      const record = asRecord(item);
      return [stringValue(record?.text) ?? stringValue(record?.content) ?? ""]
        .filter((part) => part.length > 0);
    });
    return parts.length > 0 ? parts.join("\n") : jsonPreview(value);
  }
  const record = asRecord(value);
  if (record !== null) {
    for (const key of ["command", "cmd", "input", "query", "pattern", "path"]) {
      const candidate = stringValue(record[key]);
      if (candidate !== null) return candidate;
    }
    return Object.keys(record).length === 0 ? "" : jsonPreview(record);
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

function eventTimestamp(payload: Record<string, unknown>, row: EventRow): number | null {
  if (typeof payload.timestamp === "number") return payload.timestamp;
  if (row.created_at instanceof Date) return row.created_at.getTime() / 1000;
  if (typeof row.created_at === "string") {
    const parsed = Date.parse(row.created_at);
    return Number.isNaN(parsed) ? null : parsed / 1000;
  }
  return null;
}

function durationMs(startedAt: number | null, completedAt: number | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  return Math.max(0, Math.round((completedAt - startedAt) * 1000));
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
