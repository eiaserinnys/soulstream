import type { DatabaseSync } from "node:sqlite";

import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import type {
  RunnerBootstrapRecord,
  RunnerEventOutboxRow,
} from "./sqlite_event_outbox_schema.js";
import {
  runnerRowToBootstrap,
  runnerRowToRecord,
  stringifyRunnerJson,
} from "./sqlite_event_outbox_records.js";

export function recoverRunnerOutbox(database: DatabaseSync): {
  bootstrap: RunnerBootstrapRecord | null;
  ackedThrough: number;
} {
  database.exec("BEGIN");
  try {
    const recovered = recoverSnapshot(database);
    database.exec("COMMIT");
    return recovered;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function recoverSnapshot(database: DatabaseSync): {
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
  const eventRows = rows.slice(1);
  let previous = eventRows[0]?.source_seq === 2 ? 1 : ackedThrough;
  for (const row of eventRows) {
    if (row.record_kind !== "event") throw new Error("runner event outbox record kind is invalid");
    if (row.stream_id !== bootstrap.stream_id) throw new Error("event outbox record stream mismatch");
    if (row.session_id !== bootstrap.session_id) throw new Error("event outbox record session mismatch");
    if (row.source_seq !== previous + 1) throw new Error("event outbox source_seq gap detected");
    runnerRowToRecord(row);
    previous = row.source_seq;
  }
  const latest = latestRunnerSequence(database);
  const lastDurable = eventRows.at(-1)?.source_seq ?? 1;
  if (latest > ackedThrough && lastDurable < latest) {
    throw new Error("event outbox durable unacknowledged prefix has a gap");
  }
  if (ackedThrough > latest) throw new Error("event outbox ACK exceeds durable append cursor");
  return { bootstrap, ackedThrough };
}

export function insertRunnerRecord(
  database: DatabaseSync,
  kind: "bootstrap" | "event",
  record: EventOutboxRecord,
  ackedThrough: number | null,
  runnerMetadata: unknown = null,
): void {
  database.prepare(`
    INSERT INTO runner_event_outbox (
      source_seq, record_kind, stream_id, session_id, event_type,
      payload_json, searchable_text, created_at, semantic_dedupe_key,
      session_effect_json, payload_hash, runner_metadata_json, acked_through
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.source_seq,
    kind,
    record.stream_id,
    record.session_id,
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

export function readRunnerAcknowledgedThrough(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT acked_through FROM runner_event_outbox
    WHERE record_kind = 'bootstrap'
  `).get() as { acked_through: number } | undefined;
  if (!row || !Number.isSafeInteger(row.acked_through) || row.acked_through < 1) {
    throw new Error("runner event outbox ACK cursor is invalid");
  }
  return row.acked_through;
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
