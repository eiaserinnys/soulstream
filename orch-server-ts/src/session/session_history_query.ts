import {
  isSessionTimelineEventType,
  type SessionTimelineEventType,
} from "./session_history_service.js";

export type TimelineEventTypesQueryResult =
  | { ok: true; value: SessionTimelineEventType[] | undefined }
  | { ok: false; field: "event_types"; message: string };

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
  if (values.some((item) => !isSessionTimelineEventType(item))) {
    return {
      ok: false,
      field: "event_types",
      message: "event_types contains an unsupported timeline event type",
    };
  }
  return { ok: true, value: [...new Set(values)] as SessionTimelineEventType[] };
}
