import {
  normalizeSessionStatisticsEvent,
  type FactDraft,
} from "./session_statistics_normalizer.js";
import { insertSessionStatisticsFacts } from "./session_statistics_projection.js";
import type { EventIngressSql, EventIngressQuerySql } from "../node/event_ingress_repository.js";

export const SESSION_STATISTICS_PROJECTION_SETTING_KEY = "session_statistics_projection_v1";
export const SESSION_STATISTICS_BACKFILL_BATCH_SIZE = 100;

export type SessionStatisticsProjectionState = {
  state: "backfilling" | "ready" | "rebuilding";
  normalization_version: 1;
  covered_since: string | null;
  backfill_cutoff_event_id: number | null;
  last_session_id: string | null;
  last_event_id: number | null;
};

type CheckpointRow = {
  value: unknown;
  version: unknown;
};

type SourceEventRow = {
  session_id: string;
  id: number | string;
  event_type: string;
  created_at: string | Date | null;
  payload: unknown;
};

export async function backfillSessionStatisticsProjection(
  sql: EventIngressSql,
  options: { batchSize?: number } = {},
): Promise<SessionStatisticsProjectionState> {
  const batchSize = options.batchSize ?? SESSION_STATISTICS_BACKFILL_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("session statistics backfill batchSize must be a positive integer");
  }
  return await sql.begin((transaction) => backfillBatch(transaction, batchSize));
}

async function backfillBatch(
  sql: EventIngressQuerySql,
  batchSize: number,
): Promise<SessionStatisticsProjectionState> {
  let checkpoint = await readCheckpoint(sql, true);
  if (checkpoint.state === "ready") return checkpoint;
  if (checkpoint.state === "rebuilding") {
    throw new Error("session statistics projection is rebuilding");
  }

  if (checkpoint.backfill_cutoff_event_id === null) {
    const rows = await sql<readonly { cutoff_event_id: number | string | null; covered_since: string | Date | null }[]>`
      SELECT max(id)::bigint AS cutoff_event_id, min(created_at) AS covered_since
      FROM events
    `;
    const cutoff = rows[0]?.cutoff_event_id == null ? 0 : parseEventId(rows[0].cutoff_event_id);
    checkpoint = {
      ...checkpoint,
      backfill_cutoff_event_id: cutoff,
      covered_since: toIsoTimestamp(rows[0]?.covered_since ?? null),
    };
    const saved = await saveCheckpoint(sql, checkpoint, checkpointVersion(checkpoint));
    if (!saved) return await readCheckpoint(sql, false);
  }

  const current = await readCheckpoint(sql, false);
  const cutoffEventId = current.backfill_cutoff_event_id;
  if (cutoffEventId === null) throw new Error("session statistics backfill cutoff was not initialized");
  const eventRows = await sql<readonly SourceEventRow[]>`
    SELECT session_id, id, event_type, created_at, payload
    FROM events
    WHERE id <= ${cutoffEventId}
      AND (
        ${current.last_session_id}::text IS NULL
        OR (session_id, id) > (${current.last_session_id}::text, ${current.last_event_id}::bigint)
      )
    ORDER BY session_id, id
    LIMIT ${batchSize}
  `;

  const facts: FactDraft[] = [];
  for (const row of eventRows) {
    const createdAt = toIsoTimestamp(row.created_at);
    if (createdAt === null) throw new Error("source event created_at is null");
    const normalized = normalizeSessionStatisticsEvent({
      sessionId: row.session_id,
      eventId: row.id,
      eventType: row.event_type,
      createdAt,
      payload: row.payload,
    });
    facts.push(...normalized.facts);
  }
  await insertSessionStatisticsFacts(sql, facts);

  const lastEvent = eventRows.at(-1);
  const nextState: SessionStatisticsProjectionState = {
    ...current,
    state: eventRows.length < batchSize ? "ready" : "backfilling",
    ...(lastEvent === undefined ? {} : {
      last_session_id: lastEvent.session_id,
      last_event_id: parseEventId(lastEvent.id),
    }),
  };
  const saved = await saveCheckpoint(sql, nextState, checkpointVersion(current));
  return saved ? nextState : await readCheckpoint(sql, false);
}

async function readCheckpoint(
  sql: EventIngressQuerySql,
  lock: boolean,
): Promise<SessionStatisticsProjectionState & { version: number }> {
  const rows = lock
    ? await sql<readonly CheckpointRow[]>`
        SELECT value, version
        FROM system_settings
        WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
        FOR UPDATE
      `
    : await sql<readonly CheckpointRow[]>`
        SELECT value, version
        FROM system_settings
        WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
      `;
  const row = rows[0];
  if (row === undefined) throw new Error("session statistics projection checkpoint is missing");
  const value = parseProjectionState(row.value);
  return { ...value, version: parsePositiveInteger(row.version, "checkpoint version") };
}

async function saveCheckpoint(
  sql: EventIngressQuerySql,
  state: SessionStatisticsProjectionState,
  expectedVersion: number,
): Promise<boolean> {
  const rows = await sql<readonly { version: number | string }[]>`
    UPDATE system_settings
    SET value = ${sql.json(state)},
        version = version + 1,
        updated_at = NOW(),
        updated_by = 'orch:session_statistics_backfill_v1'
    WHERE setting_key = ${SESSION_STATISTICS_PROJECTION_SETTING_KEY}
      AND version = ${expectedVersion}
    RETURNING version
  `;
  return rows.length > 0;
}

function parseProjectionState(value: unknown): SessionStatisticsProjectionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session statistics projection checkpoint is invalid");
  }
  const state = value as Record<string, unknown>;
  if (state.state !== "backfilling" && state.state !== "ready" && state.state !== "rebuilding") {
    throw new Error("session statistics projection checkpoint state is invalid");
  }
  if (state.normalization_version !== 1) {
    throw new Error("session statistics projection normalization version is unsupported");
  }
  const cutoff = state.backfill_cutoff_event_id === null
    ? null
    : parseEventId(state.backfill_cutoff_event_id);
  const lastEventId = state.last_event_id === null
    ? null
    : parseEventId(state.last_event_id);
  const lastSessionId = state.last_session_id === null
    ? null
    : typeof state.last_session_id === "string" ? state.last_session_id : null;
  if (state.last_session_id !== null && lastSessionId === null) {
    throw new Error("session statistics projection checkpoint cursor is invalid");
  }
  if (state.covered_since !== null && typeof state.covered_since !== "string") {
    throw new Error("session statistics projection covered_since is invalid");
  }
  return {
    state: state.state,
    normalization_version: 1,
    covered_since: state.covered_since as string | null,
    backfill_cutoff_event_id: cutoff,
    last_session_id: lastSessionId,
    last_event_id: lastEventId,
  };
}

function parseEventId(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("session statistics event id is invalid");
  }
  return parsed;
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = parseEventId(value);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function toIsoTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("source event timestamp is invalid");
  return date.toISOString();
}

function checkpointVersion(state: SessionStatisticsProjectionState): number {
  const candidate = state as SessionStatisticsProjectionState & { version?: number };
  if (candidate.version === undefined) throw new Error("checkpoint version is missing");
  return candidate.version;
}
