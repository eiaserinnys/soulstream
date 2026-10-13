import type { HostEventRow, HostEventSearchRow } from "./event_read_repository.js";

export type EventSearchRecord = Omit<HostEventSearchRow, "payload"> & { payload: unknown };

export function isPostgresStatementTimeout(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "57014";
}

export function normalizeEvent(
  row: Omit<HostEventRow, "payload"> & { payload: unknown },
): HostEventRow {
  return {
    id: Number(row.id),
    session_id: row.session_id,
    event_type: row.event_type,
    payload: row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : {},
    searchable_text: row.searchable_text,
    created_at: row.created_at,
  };
}
