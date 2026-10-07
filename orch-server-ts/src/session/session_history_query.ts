import {
  ALLOWED_TIMELINE_DEBUG_KINDS,
  isRequestedTimelineEventType,
  type RequestedTimelineDebugKind,
  type RequestedTimelineEventType,
} from "./session_history_service.js";

export type TimelineEventTypesQueryResult =
  | { ok: true; value: RequestedTimelineEventType[] | undefined }
  | { ok: false; field: "event_types"; message: string };

export type TimelineDebugKindsQueryResult =
  | { ok: true; value: RequestedTimelineDebugKind[] | undefined }
  | { ok: false; field: "debug_kinds"; message: string };

export function parseTimelineEventTypesQuery(
  value: unknown,
): TimelineEventTypesQueryResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      field: "event_types",
      message: "event_types must be a non-empty comma-separated list",
    };
  }
  const values = value.split(",");
  if (values.some((item) => !isRequestedTimelineEventType(item))) {
    return {
      ok: false,
      field: "event_types",
      message: "event_types contains an unsupported timeline event type",
    };
  }
  return { ok: true, value: [...new Set(values)] as RequestedTimelineEventType[] };
}

export function parseTimelineDebugKindsQuery(
  value: unknown,
): TimelineDebugKindsQueryResult {
  if (value === undefined) return { ok: true, value: undefined };
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length === 0
    || values.some((item) => typeof item !== "string" || !ALLOWED_TIMELINE_DEBUG_KINDS.has(item as RequestedTimelineDebugKind))
  ) {
    return {
      ok: false,
      field: "debug_kinds",
      message: "debug_kinds must be a non-empty list of supported values",
    };
  }
  return { ok: true, value: [...new Set(values)] as RequestedTimelineDebugKind[] };
}
