import type { SupervisorWakeDispatchState } from "../../supervisor/wake_dispatch_state.js";
import type {
  AppendSupervisorEventParams,
  SqlClient,
  SupervisorAppendResult,
  SupervisorEventRow,
  SupervisorRegistryRow,
  SupervisorRegistryUpsertParams,
  SupervisorSourceCursorRow,
  SupervisorWakeDispatchStateParams,
} from "../session_db_types.js";
import {
  numberFromDb,
  recordFromDb,
} from "./repository_helpers.js";

export class SupervisorRepository {
  constructor(private readonly sql: SqlClient) {}

  async appendSupervisorEvent(
    params: AppendSupervisorEventParams,
  ): Promise<SupervisorAppendResult> {
    const rows = await this.sql<
      Array<{
        offset: string | number;
        inserted: boolean;
        contiguous_upto: string | number;
        highest_seen_event_id: string | number;
        gap_start: string | number | null;
        gap_end: string | number | null;
      }>
    >`
      SELECT * FROM supervisor_event_append(
        ${params.sourceNode},
        ${params.sourceSessionId},
        ${params.sourceEventId},
        ${params.eventType},
        ${JSON.stringify(params.payload)},
        ${params.createdAt}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_event_append returned no row");
    }
    return mapSupervisorAppendRow(row);
  }

  async readSupervisorEventsAfter(
    afterOffset = 0,
    limit = 100,
  ): Promise<SupervisorEventRow[]> {
    const rows = await this.sql<
      Array<{
        offset: string | number;
        source_node: string;
        source_session_id: string;
        source_event_id: string | number;
        event_type: string;
        payload: unknown;
        created_at: Date;
        inserted_at: Date;
      }>
    >`
      SELECT * FROM supervisor_event_read_after(${afterOffset}, ${limit})
    `;
    return rows.map((row) => ({
      offset: numberFromDb(row.offset, "supervisor_events.offset"),
      sourceNode: row.source_node,
      sourceSessionId: row.source_session_id,
      sourceEventId: numberFromDb(row.source_event_id, "supervisor_events.source_event_id"),
      eventType: row.event_type,
      payload: recordFromDb(row.payload),
      createdAt: row.created_at,
      insertedAt: row.inserted_at,
    }));
  }

  async getSupervisorEventHeadOffset(): Promise<number> {
    const rows = await this.sql<Array<{ head: string | number | null }>>`
      SELECT COALESCE(MAX("offset"), 0) AS head FROM supervisor_events
    `;
    return rows[0]?.head == null
      ? 0
      : numberFromDb(rows[0].head, "supervisor_events.head");
  }

  async getSupervisorSourceCursor(
    sourceNode: string,
    sourceSessionId: string,
  ): Promise<SupervisorSourceCursorRow | null> {
    const rows = await this.sql<
      Array<{
        source_node: string;
        source_session_id: string;
        contiguous_upto: string | number;
        highest_seen_event_id: string | number;
        gap_start: string | number | null;
        gap_end: string | number | null;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_source_cursor_get(${sourceNode}, ${sourceSessionId})
    `;
    const row = rows[0];
    return row ? mapSupervisorSourceCursorRow(row) : null;
  }

  async setSupervisorSourceCursor(params: {
    sourceNode: string;
    sourceSessionId: string;
    contiguousUpto: number;
    highestSeenEventId: number;
    gapStart?: number | null;
    gapEnd?: number | null;
  }): Promise<SupervisorSourceCursorRow> {
    const rows = await this.sql<
      Array<{
        source_node: string;
        source_session_id: string;
        contiguous_upto: string | number;
        highest_seen_event_id: string | number;
        gap_start: string | number | null;
        gap_end: string | number | null;
        updated_at: Date;
      }>
    >`
      SELECT * FROM supervisor_source_cursor_set(
        ${params.sourceNode},
        ${params.sourceSessionId},
        ${params.contiguousUpto},
        ${params.highestSeenEventId},
        ${params.gapStart ?? null},
        ${params.gapEnd ?? null}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_source_cursor_set returned no row");
    }
    return mapSupervisorSourceCursorRow(row);
  }

  async getSupervisorConsumerCursor(supervisorId: string): Promise<number> {
    const rows = await this.sql<
      Array<{ supervisor_consumer_cursor_get: string | number }>
    >`
      SELECT supervisor_consumer_cursor_get(${supervisorId}) AS supervisor_consumer_cursor_get
    `;
    return Number(rows[0]?.supervisor_consumer_cursor_get ?? 0);
  }

  async setSupervisorConsumerCursor(
    supervisorId: string,
    cursorOffset: number,
  ): Promise<number> {
    const rows = await this.sql<
      Array<{ supervisor_consumer_cursor_set: string | number }>
    >`
      SELECT supervisor_consumer_cursor_set(
        ${supervisorId},
        ${cursorOffset}
      ) AS supervisor_consumer_cursor_set
    `;
    return Number(rows[0]?.supervisor_consumer_cursor_set ?? 0);
  }

  async setSupervisorWakeDispatchState(
    params: SupervisorWakeDispatchStateParams,
  ): Promise<SupervisorRegistryRow> {
    const rows = await this.sql<Array<SupervisorRegistryDbRow>>`
      SELECT * FROM supervisor_registry_set_wake_dispatch_state(
        ${params.role},
        ${params.state},
        ${params.lastSignature ?? null},
        ${params.repeatCount},
        ${params.blockedReason ?? null},
        ${params.blockedAt ?? null}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_registry_set_wake_dispatch_state returned no row");
    }
    return mapSupervisorRegistryRow(row);
  }

  async upsertSupervisorRegistry(
    params: SupervisorRegistryUpsertParams,
  ): Promise<SupervisorRegistryRow> {
    const rows = await this.sql<Array<SupervisorRegistryDbRow>>`
      SELECT * FROM supervisor_registry_upsert(
        ${params.role},
        ${params.activeSessionId},
        ${params.epoch},
        ${params.cursorOffset},
        ${params.handoverState},
        ${params.cumulativeTokens},
        ${params.compactionCount},
        ${params.lastSeenAt}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_registry_upsert returned no row");
    }
    return mapSupervisorRegistryRow(row);
  }

  async getSupervisorRegistry(role: string): Promise<SupervisorRegistryRow | null> {
    const rows = await this.sql<Array<SupervisorRegistryDbRow>>`
      SELECT * FROM supervisor_registry_get(${role})
    `;
    const row = rows[0];
    return row ? mapSupervisorRegistryRow(row) : null;
  }

  async listSupervisorRegistries(): Promise<SupervisorRegistryRow[]> {
    const rows = await this.sql<Array<SupervisorRegistryDbRow>>`
      SELECT * FROM supervisor_registry_list()
    `;
    return rows.map((row) => mapSupervisorRegistryRow(row));
  }

  async touchSupervisorRegistry(
    role: string,
    lastSeenAt: Date,
  ): Promise<SupervisorRegistryRow | null> {
    const rows = await this.sql<Array<SupervisorRegistryDbRow>>`
      SELECT * FROM supervisor_registry_touch(${role}, ${lastSeenAt})
    `;
    const row = rows[0];
    return row ? mapSupervisorRegistryRow(row) : null;
  }

  async recordSupervisorUsageDelta(params: {
    role: string;
    tokenDelta: number;
    compactionDelta?: number;
    lastSeenAt?: Date | null;
  }): Promise<SupervisorRegistryRow> {
    const rows = await this.sql<Array<SupervisorRegistryDbRow>>`
      SELECT * FROM supervisor_registry_record_usage_delta(
        ${params.role},
        ${params.tokenDelta},
        ${params.compactionDelta ?? 0},
        ${params.lastSeenAt ?? null}
      )
    `;
    const row = rows[0];
    if (!row) {
      throw new Error("supervisor_registry_record_usage_delta returned no row");
    }
    return mapSupervisorRegistryRow(row);
  }

  async deleteSupervisorRegistry(role: string): Promise<boolean> {
    const rows = await this.sql<Array<{ supervisor_registry_delete: boolean }>>`
      SELECT supervisor_registry_delete(${role}) AS supervisor_registry_delete
    `;
    return Boolean(rows[0]?.supervisor_registry_delete);
  }
}

interface SupervisorRegistryDbRow {
  role: string;
  active_session_id: string | null;
  epoch: string | number;
  cursor_offset: string | number;
  handover_state: string;
  cumulative_tokens: string | number;
  compaction_count: string | number;
  last_seen_at: Date | null;
  wake_dispatch_state?: string | null;
  wake_last_signature?: string | null;
  wake_repeat_count?: string | number | null;
  wake_blocked_reason?: string | null;
  wake_blocked_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapSupervisorAppendRow(row: {
  offset: string | number;
  inserted: boolean;
  contiguous_upto: string | number;
  highest_seen_event_id: string | number;
  gap_start: string | number | null;
  gap_end: string | number | null;
}): SupervisorAppendResult {
  return {
    offset: numberFromDb(row.offset, "supervisor_event_append.offset"),
    inserted: row.inserted,
    contiguousUpto: numberFromDb(row.contiguous_upto, "supervisor_event_append.contiguous_upto"),
    highestSeenEventId: numberFromDb(
      row.highest_seen_event_id,
      "supervisor_event_append.highest_seen_event_id",
    ),
    gapStart: row.gap_start === null ? null : numberFromDb(row.gap_start, "supervisor_event_append.gap_start"),
    gapEnd: row.gap_end === null ? null : numberFromDb(row.gap_end, "supervisor_event_append.gap_end"),
  };
}

function mapSupervisorSourceCursorRow(row: {
  source_node: string;
  source_session_id: string;
  contiguous_upto: string | number;
  highest_seen_event_id: string | number;
  gap_start: string | number | null;
  gap_end: string | number | null;
  updated_at: Date;
}): SupervisorSourceCursorRow {
  return {
    sourceNode: row.source_node,
    sourceSessionId: row.source_session_id,
    contiguousUpto: numberFromDb(row.contiguous_upto, "supervisor_source_cursor.contiguous_upto"),
    highestSeenEventId: numberFromDb(
      row.highest_seen_event_id,
      "supervisor_source_cursor.highest_seen_event_id",
    ),
    gapStart: row.gap_start === null ? null : numberFromDb(row.gap_start, "supervisor_source_cursor.gap_start"),
    gapEnd: row.gap_end === null ? null : numberFromDb(row.gap_end, "supervisor_source_cursor.gap_end"),
    updatedAt: row.updated_at,
  };
}

function mapSupervisorRegistryRow(row: SupervisorRegistryDbRow): SupervisorRegistryRow {
  return {
    role: row.role,
    activeSessionId: row.active_session_id,
    epoch: numberFromDb(row.epoch, "supervisor_registry.epoch"),
    cursorOffset: numberFromDb(row.cursor_offset, "supervisor_registry.cursor_offset"),
    handoverState: row.handover_state,
    cumulativeTokens: numberFromDb(row.cumulative_tokens, "supervisor_registry.cumulative_tokens"),
    compactionCount: numberFromDb(row.compaction_count, "supervisor_registry.compaction_count"),
    lastSeenAt: row.last_seen_at,
    wakeDispatchState: normalizeSupervisorWakeDispatchState(row.wake_dispatch_state),
    wakeLastSignature: row.wake_last_signature ?? null,
    wakeRepeatCount: numberFromDb(
      row.wake_repeat_count ?? 0,
      "supervisor_registry.wake_repeat_count",
    ),
    wakeBlockedReason: row.wake_blocked_reason ?? null,
    wakeBlockedAt: row.wake_blocked_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSupervisorWakeDispatchState(
  state: string | null | undefined,
): SupervisorWakeDispatchState {
  if (state === "retrying" || state === "blocked") return state;
  return "active";
}
