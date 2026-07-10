import type {
  SupervisorAppendInput,
  SupervisorAppendResult,
  SupervisorIngestRepository,
  SupervisorSourceCursor,
  SupervisorSourceEvent,
} from "../supervisor/supervisor_ingest.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";

export type CreateLiveSupervisorIngestRepositoryOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
};

export function createLiveSupervisorIngestRepository(
  options: CreateLiveSupervisorIngestRepositoryOptions,
): SupervisorIngestRepository {
  return {
    async appendSupervisorEvent(input) {
      const sql = await options.sqlResolver.resolveSql();
      const rows = await sql`
        SELECT * FROM supervisor_event_append(
          ${input.sourceNode},
          ${input.sourceSessionId},
          ${input.sourceEventId},
          ${input.eventType},
          ${JSON.stringify(input.payload)},
          ${input.createdAt}
        )
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("supervisor_event_append returned no row");
      return appendResult(row);
    },
    async getSupervisorSourceCursor(sourceNode, sourceSessionId) {
      const sql = await options.sqlResolver.resolveSql();
      const rows = await sql`
        SELECT * FROM supervisor_source_cursor_get(${sourceNode}, ${sourceSessionId})
      `;
      const row = rows[0];
      return row === undefined ? null : sourceCursor(row);
    },
    async readEvents(sessionId, afterId, limit) {
      const sql = await options.sqlResolver.resolveSql();
      const rows = await sql`
        SELECT * FROM event_read(${sessionId}, ${afterId}, ${limit}, ${null})
      `;
      return rows.map(sourceEvent);
    },
  };
}

function appendResult(row: Record<string, unknown>): SupervisorAppendResult {
  return {
    offset: requiredNumber(row.offset, "supervisor_events.offset"),
    inserted: row.inserted === true,
    contiguousUpto: requiredNumber(row.contiguous_upto, "contiguous_upto"),
    highestSeenEventId: requiredNumber(
      row.highest_seen_event_id,
      "highest_seen_event_id",
    ),
    gapStart: nullableNumber(row.gap_start, "gap_start"),
    gapEnd: nullableNumber(row.gap_end, "gap_end"),
  };
}

function sourceCursor(row: Record<string, unknown>): SupervisorSourceCursor {
  return {
    sourceNode: requiredString(row.source_node, "source_node"),
    sourceSessionId: requiredString(row.source_session_id, "source_session_id"),
    contiguousUpto: requiredNumber(row.contiguous_upto, "contiguous_upto"),
    highestSeenEventId: requiredNumber(
      row.highest_seen_event_id,
      "highest_seen_event_id",
    ),
    gapStart: nullableNumber(row.gap_start, "gap_start"),
    gapEnd: nullableNumber(row.gap_end, "gap_end"),
    ...(dateOrString(row.updated_at) === undefined
      ? {}
      : { updatedAt: dateOrString(row.updated_at) }),
  };
}

function sourceEvent(row: Record<string, unknown>): SupervisorSourceEvent {
  return {
    id: requiredNumber(row.id, "events.id"),
    eventType: requiredString(row.event_type, "events.event_type"),
    payload: row.payload,
    createdAt: dateOrString(row.created_at) ?? null,
  };
}

function requiredNumber(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

function nullableNumber(value: unknown, name: string): number | null {
  return value === null || value === undefined ? null : requiredNumber(value, name);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function dateOrString(value: unknown): Date | string | undefined {
  return value instanceof Date || typeof value === "string" ? value : undefined;
}
