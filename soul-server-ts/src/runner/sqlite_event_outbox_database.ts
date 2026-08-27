import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { advanceUnacknowledgedSourceSequence } from "../event_outbox_recovery.js";
import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import {
  RUNNER_EVENT_OUTBOX_READ_ONLY_REQUIRED_COLUMNS,
  RUNNER_EVENT_OUTBOX_READ_ONLY_SCHEMA_VERSIONS,
  RUNNER_EVENT_OUTBOX_SCHEMA_VERSION,
  type RunnerBootstrapRecord,
  type RunnerEventOutboxRow,
} from "./sqlite_event_outbox_schema.js";
import {
  runnerRowToBootstrap,
  runnerRowToRecord,
  stringifyRunnerJson,
} from "./sqlite_event_outbox_records.js";

export function recoverRunnerOutbox(
  database: DatabaseSync,
  options: { migrateLegacyAckCheckpoint?: boolean } = {},
): {
  bootstrap: RunnerBootstrapRecord | null;
  ackedThrough: number;
} {
  database.exec("BEGIN");
  try {
    if (!runnerTableHasColumn(database, "runner_event_outbox", "ack_checkpoint_hash")) {
      if (!options.migrateLegacyAckCheckpoint) {
        throw new Error("runner event outbox ACK checkpoint hash is missing");
      }
      database.exec(`
        ALTER TABLE runner_event_outbox
        ADD COLUMN ack_checkpoint_hash TEXT CHECK (
          ack_checkpoint_hash IS NULL OR (
            length(ack_checkpoint_hash) = 64
            AND ack_checkpoint_hash = lower(ack_checkpoint_hash)
          )
        )
      `);
    }
    const recovered = recoverSnapshot(database, options);
    database.exec("COMMIT");
    return recovered;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Validates bootstrap plus the unacknowledged suffix without reading the compactable prefix. */
export function recoverRunnerOutboxTail(database: DatabaseSync): {
  bootstrap: RunnerBootstrapRecord | null;
  ackedThrough: number;
} {
  database.exec("BEGIN");
  try {
    const bootstrapRow = database.prepare(`
      SELECT * FROM runner_event_outbox WHERE record_kind = 'bootstrap'
    `).get() as unknown as RunnerEventOutboxRow | undefined;
    const latest = latestRunnerSequence(database);
    if (!bootstrapRow) {
      if (latest !== 0) throw new Error("runner bootstrap is missing before durable records");
      database.exec("COMMIT");
      return { bootstrap: null, ackedThrough: 0 };
    }
    if (bootstrapRow.source_seq !== 1) {
      throw new Error("runner bootstrap record must be source_seq 1");
    }
    assertRunnerAckCheckpoint(bootstrapRow);
    const bootstrap = runnerRowToBootstrap(bootstrapRow);
    const ackedThrough = bootstrapRow.acked_through!;
    if (ackedThrough > latest) throw new Error("event outbox ACK exceeds durable append cursor");
    const rows = database.prepare(`
      SELECT * FROM runner_event_outbox WHERE source_seq > ? ORDER BY source_seq
    `).all(ackedThrough) as unknown as RunnerEventOutboxRow[];
    let previous = ackedThrough;
    for (const row of rows) {
      if (row.record_kind !== "event") throw new Error("runner event outbox record kind is invalid");
      if (row.stream_id !== bootstrap.stream_id) throw new Error("event outbox record stream mismatch");
      if (row.session_id !== bootstrap.session_id) throw new Error("event outbox record session mismatch");
      runnerRowToRecord(row);
      previous = advanceUnacknowledgedSourceSequence(row.source_seq, ackedThrough, previous);
    }
    if (latest > ackedThrough && previous < latest) {
      throw new Error(
        `event outbox durable unacknowledged suffix has a gap: expected through ${latest}, `
        + `found through ${previous}, acked_through ${ackedThrough}`,
      );
    }
    database.exec("COMMIT");
    return { bootstrap, ackedThrough };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function recoverSnapshot(
  database: DatabaseSync,
  options: { migrateLegacyAckCheckpoint?: boolean },
): {
  bootstrap: RunnerBootstrapRecord | null;
  ackedThrough: number;
} {
  const rows = database.prepare(
    "SELECT * FROM runner_event_outbox ORDER BY source_seq",
  ).all() as unknown as RunnerEventOutboxRow[];
  if (rows.length === 0) return { bootstrap: null, ackedThrough: 0 };

  const bootstrapRow = rows[0]!;
  if (bootstrapRow.record_kind !== "bootstrap" || bootstrapRow.source_seq !== 1) {
    throw new Error("runner bootstrap record must be source_seq 1");
  }
  const bootstrap = runnerRowToBootstrap(bootstrapRow);
  const ackedThrough = bootstrapRow.acked_through;
  if (ackedThrough === null || ackedThrough < 1) {
    throw new Error("runner event outbox ACK cursor is invalid");
  }
  const legacyCheckpoint = bootstrapRow.ack_checkpoint_hash == null;
  if (!legacyCheckpoint) assertRunnerAckCheckpoint(bootstrapRow);
  if (legacyCheckpoint && !options.migrateLegacyAckCheckpoint) {
    throw new Error("runner event outbox ACK checkpoint hash is missing");
  }
  const eventRows = rows.slice(1);
  let previousUnacknowledged = ackedThrough;
  for (const row of eventRows) {
    if (row.record_kind !== "event") throw new Error("runner event outbox record kind is invalid");
    if (row.stream_id !== bootstrap.stream_id) throw new Error("event outbox record stream mismatch");
    if (row.session_id !== bootstrap.session_id) throw new Error("event outbox record session mismatch");
    runnerRowToRecord(row);
    previousUnacknowledged = advanceUnacknowledgedSourceSequence(
      row.source_seq,
      ackedThrough,
      previousUnacknowledged,
    );
  }
  const latest = latestRunnerSequence(database);
  if (latest > ackedThrough && previousUnacknowledged < latest) {
    throw new Error(
      `event outbox durable unacknowledged suffix has a gap: expected through ${latest}, `
      + `found through ${previousUnacknowledged}, acked_through ${ackedThrough}`,
    );
  }
  if (ackedThrough > latest) throw new Error("event outbox ACK exceeds durable append cursor");
  if (legacyCheckpoint) {
    const checkpointHash = computeRunnerAckCheckpointHash(
      bootstrap.stream_id,
      bootstrap.session_id,
      ackedThrough,
    );
    const result = database.prepare(`
      UPDATE runner_event_outbox SET ack_checkpoint_hash = ?
      WHERE record_kind = 'bootstrap' AND ack_checkpoint_hash IS NULL
    `).run(checkpointHash);
    if (Number(result.changes) !== 1) {
      throw new Error("runner event outbox legacy ACK checkpoint migration conflicted");
    }
    bootstrapRow.ack_checkpoint_hash = checkpointHash;
    assertRunnerAckCheckpoint(bootstrapRow);
  }
  return { bootstrap, ackedThrough };
}

export function insertRunnerRecord(
  database: DatabaseSync,
  kind: "bootstrap" | "event",
  record: EventOutboxRecord,
  ackedThrough: number | null,
  runnerMetadata: unknown = null,
  ackCheckpointHash: string | null = null,
): void {
  database.prepare(`
    INSERT INTO runner_event_outbox (
      source_seq, record_kind, stream_id, session_id, execution_generation, event_type,
      payload_json, searchable_text, created_at, semantic_dedupe_key,
      session_effect_json, payload_hash, runner_metadata_json, acked_through,
      ack_checkpoint_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source_seq,
    kind,
    record.stream_id,
    record.session_id,
    record.execution_generation ?? null,
    record.event_type,
    stringifyRunnerJson(record.payload, "payload"),
    record.searchable_text,
    record.created_at,
    record.semantic_dedupe_key,
    record.session_effect === null
      ? null
      : stringifyRunnerJson(record.session_effect, "session_effect"),
    record.payload_hash,
    runnerMetadata === null
      ? null
      : stringifyRunnerJson(runnerMetadata, "runner metadata"),
    ackedThrough,
    ackCheckpointHash,
  );
}

export function latestRunnerSequence(database: DatabaseSync): number {
  const row = database.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name = 'runner_event_outbox'",
  ).get() as { seq: number } | undefined;
  return row?.seq ?? 0;
}

export function runnerRowCount(database: DatabaseSync): number {
  const row = database.prepare(
    "SELECT COUNT(*) AS count FROM runner_event_outbox",
  ).get() as { count: number };
  return row.count;
}

export function readRunnerSchemaVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function assertRunnerReadOnlySchema(database: DatabaseSync, version: number): void {
  if (!RUNNER_EVENT_OUTBOX_READ_ONLY_SCHEMA_VERSIONS.has(version)) {
    throw new Error(`runner event outbox schema version ${version} is not supported read-only`);
  }
  const requiredColumns = version === RUNNER_EVENT_OUTBOX_SCHEMA_VERSION
    ? [...RUNNER_EVENT_OUTBOX_READ_ONLY_REQUIRED_COLUMNS, "execution_generation"]
    : RUNNER_EVENT_OUTBOX_READ_ONLY_REQUIRED_COLUMNS;
  const columns = new Set(
    (database.prepare("PRAGMA table_info(runner_event_outbox)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  const missing = requiredColumns.find((column) => !columns.has(column));
  if (missing) {
    throw new Error(`runner event outbox schema is missing required column ${missing}`);
  }
}

export function readRunnerAcknowledgedThrough(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT stream_id, session_id, acked_through, ack_checkpoint_hash
    FROM runner_event_outbox
    WHERE record_kind = 'bootstrap'
  `).get() as Pick<
    RunnerEventOutboxRow,
    "stream_id" | "session_id" | "acked_through" | "ack_checkpoint_hash"
  > | undefined;
  if (!row || typeof row.acked_through !== "number"
    || !Number.isSafeInteger(row.acked_through) || row.acked_through < 1) {
    throw new Error("runner event outbox ACK cursor is invalid");
  }
  assertRunnerAckCheckpoint(row);
  return row.acked_through;
}

export function computeRunnerAckCheckpointHash(
  streamId: string,
  sessionId: string,
  ackedThrough: number,
): string {
  if (!streamId || !sessionId || !Number.isSafeInteger(ackedThrough) || ackedThrough < 1) {
    throw new Error("runner event outbox ACK checkpoint is invalid");
  }
  return createHash("sha256").update(JSON.stringify({
    schema_version: 1,
    stream_id: streamId,
    session_id: sessionId,
    acked_through: ackedThrough,
  })).digest("hex");
}

export function assertRunnerAckCheckpoint(row: Pick<
  RunnerEventOutboxRow,
  "stream_id" | "session_id" | "acked_through" | "ack_checkpoint_hash"
>): void {
  if (typeof row.acked_through !== "number" || row.ack_checkpoint_hash == null) {
    throw new Error("runner event outbox ACK checkpoint hash is missing");
  }
  const expected = computeRunnerAckCheckpointHash(
    row.stream_id,
    row.session_id,
    row.acked_through,
  );
  if (row.ack_checkpoint_hash !== expected) {
    throw new Error("runner event outbox ACK checkpoint hash mismatch");
  }
}

export function runnerTableHasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return columns.some((entry) => entry.name === column);
}
