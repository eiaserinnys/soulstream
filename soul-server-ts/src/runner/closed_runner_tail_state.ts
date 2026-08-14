import type { DatabaseSync } from "node:sqlite";

import {
  readRunnerHostAcknowledgedThrough,
  runnerHostStatePath,
} from "./runner_host_state_store.js";
import {
  openRunnerSqliteReadOnlyDatabase,
  requireRunnerSqliteWal,
} from "./runner_sqlite_connection.js";
import {
  assertRunnerAckCheckpoint,
  latestRunnerSequence,
  readRunnerSchemaVersion,
} from "./sqlite_event_outbox_database.js";
import { runnerRowToBootstrap } from "./sqlite_event_outbox_records.js";
import {
  RUNNER_EVENT_OUTBOX_SCHEMA_VERSION,
  type RunnerEventOutboxRow,
} from "./sqlite_event_outbox_schema.js";

export type ClosedRunnerTailState = {
  status: "empty_prebootstrap";
  streamId: null;
  sessionId: string;
  latestDurableSourceSeq: 0;
  acknowledgedThrough: null;
} | {
  status: "fully_acknowledged" | "requires_drain";
  streamId: string;
  sessionId: string;
  latestDurableSourceSeq: number;
  acknowledgedThrough: number | null;
} | {
  status: "unknown";
  reason: string;
};

/** Reads only immutable bootstrap identity, append head, and the host ACK cursor. */
export function readClosedRunnerTailState(
  databasePath: string,
  expectedSessionId: string,
): ClosedRunnerTailState {
  let database: DatabaseSync | undefined;
  try {
    database = openRunnerSqliteReadOnlyDatabase(databasePath);
    requireRunnerSqliteWal(database);
    const version = readRunnerSchemaVersion(database);
    if (version !== RUNNER_EVENT_OUTBOX_SCHEMA_VERSION) {
      throw new Error(`runner event outbox schema version ${version} requires writer migration`);
    }
    const latestDurableSourceSeq = latestRunnerSequence(database);
    const row = database.prepare(`
      SELECT * FROM runner_event_outbox WHERE record_kind = 'bootstrap'
    `).get() as unknown as RunnerEventOutboxRow | undefined;
    if (!row) {
      if (latestDurableSourceSeq !== 0) {
        throw new Error("runner bootstrap is missing before the durable append head");
      }
      return {
        status: "empty_prebootstrap",
        streamId: null,
        sessionId: expectedSessionId,
        latestDurableSourceSeq: 0,
        acknowledgedThrough: null,
      };
    }
    // Compaction deletes only record_kind='event', so bootstrap identity remains
    // available. The append head must come from sqlite_sequence rather than MAX:
    // deleting an acknowledged prefix must never make the durable head regress.
    if (row.source_seq !== 1) throw new Error("runner bootstrap record must be source_seq 1");
    assertRunnerAckCheckpoint(row);
    const bootstrap = runnerRowToBootstrap(row);
    if (bootstrap.session_id !== expectedSessionId) {
      throw new Error("runner bootstrap session differs from registration");
    }
    if (latestDurableSourceSeq < 1) {
      throw new Error("runner durable append head precedes bootstrap");
    }
    const acknowledgedThrough = readRunnerHostAcknowledgedThrough(
      runnerHostStatePath(databasePath),
      bootstrap.stream_id,
      bootstrap.session_id,
    );
    if (acknowledgedThrough !== null && acknowledgedThrough > latestDurableSourceSeq) {
      throw new Error("runner host ACK exceeds durable runner source_seq");
    }
    return {
      status: acknowledgedThrough === latestDurableSourceSeq
        ? "fully_acknowledged"
        : "requires_drain",
      streamId: bootstrap.stream_id,
      sessionId: bootstrap.session_id,
      latestDurableSourceSeq,
      acknowledgedThrough,
    };
  } catch (error) {
    return { status: "unknown", reason: asError(error).message };
  } finally {
    database?.close();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
