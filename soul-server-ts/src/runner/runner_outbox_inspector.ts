import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import {
  latestRunnerSequence,
  recoverRunnerOutbox,
} from "./sqlite_event_outbox_database.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type RunnerOutboxInspection = {
  status:
    | "healthy"
    | "compacted_acknowledged_prefix"
    | "legacy_unprotected_checkpoint"
    | "quarantine_required";
  sessionId: string | null;
  streamId: string | null;
  ackedThrough: number | null;
  latestSequence: number;
  firstRetainedEventSequence: number | null;
  lastRetainedEventSequence: number | null;
  retainedEventCount: number;
  unacknowledgedEventCount: number;
  error?: string;
};

/**
 * Inspects a filesystem copy of runner.sqlite without changing its schema or
 * cursor. Callers must copy runner.sqlite together with any -wal/-shm siblings
 * before invoking this function; opening a live writer DB is not an operator
 * recovery procedure.
 */
export function inspectRunnerOutboxCopy(databasePath: string): RunnerOutboxInspection {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const raw = readRawSummary(database);
    if (raw.sessionId !== null && !hasProtectedAckCheckpoint(database)) {
      return {
        ...raw,
        status: "legacy_unprotected_checkpoint",
        error: "legacy runner outbox requires writable v5-to-v6 ACK checkpoint migration",
      };
    }
    try {
      const recovered = recoverRunnerOutbox(database);
      const compacted = recovered.ackedThrough > 1
        && (
          raw.firstRetainedEventSequence === null
          || raw.firstRetainedEventSequence > 2
          || raw.retainedEventCount < raw.latestSequence - 1
        );
      return {
        ...raw,
        status: compacted ? "compacted_acknowledged_prefix" : "healthy",
        sessionId: recovered.bootstrap?.session_id ?? null,
        streamId: recovered.bootstrap?.stream_id ?? null,
        ackedThrough: recovered.bootstrap === null ? null : recovered.ackedThrough,
      };
    } catch (error) {
      return {
        status: "quarantine_required",
        sessionId: raw.sessionId,
        streamId: raw.streamId,
        ackedThrough: raw.ackedThrough,
        latestSequence: raw.latestSequence,
        firstRetainedEventSequence: raw.firstRetainedEventSequence,
        lastRetainedEventSequence: raw.lastRetainedEventSequence,
        retainedEventCount: raw.retainedEventCount,
        unacknowledgedEventCount: raw.unacknowledgedEventCount,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    database.close();
  }
}

function hasProtectedAckCheckpoint(database: DatabaseSyncType): boolean {
  const columns = database.prepare("PRAGMA table_info(runner_event_outbox)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "ack_checkpoint_hash")) return false;
  const row = database.prepare(`
    SELECT ack_checkpoint_hash FROM runner_event_outbox
    WHERE record_kind = 'bootstrap'
  `).get() as { ack_checkpoint_hash: string | null } | undefined;
  return row?.ack_checkpoint_hash != null;
}

function readRawSummary(database: DatabaseSyncType): Omit<
  RunnerOutboxInspection,
  "status" | "error"
> {
  const bootstrap = database.prepare(`
    SELECT session_id, stream_id, acked_through
    FROM runner_event_outbox
    WHERE record_kind = 'bootstrap'
  `).get() as {
    session_id: string;
    stream_id: string;
    acked_through: number;
  } | undefined;
  const events = database.prepare(`
    SELECT
      MIN(source_seq) AS first_seq,
      MAX(source_seq) AS last_seq,
      COUNT(*) AS retained_count,
      COALESCE(SUM(CASE WHEN source_seq > ? THEN 1 ELSE 0 END), 0) AS unacknowledged_count
    FROM runner_event_outbox
    WHERE record_kind = 'event'
  `).get(bootstrap?.acked_through ?? 0) as {
    first_seq: number | null;
    last_seq: number | null;
    retained_count: number;
    unacknowledged_count: number;
  };
  return {
    sessionId: bootstrap?.session_id ?? null,
    streamId: bootstrap?.stream_id ?? null,
    ackedThrough: bootstrap?.acked_through ?? null,
    latestSequence: latestRunnerSequence(database),
    firstRetainedEventSequence: events.first_seq,
    lastRetainedEventSequence: events.last_seq,
    retainedEventCount: events.retained_count,
    unacknowledgedEventCount: events.unacknowledged_count,
  };
}
