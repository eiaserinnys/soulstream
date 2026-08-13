import type { DatabaseSync } from "node:sqlite";

import { RUNNER_IPC_JOURNAL_DDL } from "./sqlite_event_outbox_schema.js";
import {
  withRunnerSqliteTransaction,
  withRunnerSqliteTransactionSync,
  type RunnerSqliteTransactionOptions,
} from "./runner_sqlite_connection.js";

export interface RunnerHostCallAppliedInput {
  correlationId: string;
  service: string;
  operation: string;
  createdAt: string;
}

export interface RunnerHostCallApplied {
  correlationId: string;
  service: string;
  operation: string;
}

export function ensureRunnerIpcJournalV4(database: DatabaseSync): void {
  if (tableHasColumn(database, "runner_ipc_journal", "correlation_id")) return;
  withRunnerSqliteTransactionSync(database, () => {
    // SQLite cannot relax a STRICT table CHECK in place. This physical table
    // rebuild preserves every v3 frame_seq and meaning, then adds nullable
    // host-call receipt columns without copying domain payload.
    database.exec("ALTER TABLE runner_ipc_journal RENAME TO runner_ipc_journal_v3");
    database.exec(RUNNER_IPC_JOURNAL_DDL);
    database.exec(`
      INSERT INTO runner_ipc_journal (
        frame_seq, outbox_source_seq, correlation_id, frame_kind,
        host_acked, service, operation, created_at
      )
      SELECT frame_seq, outbox_source_seq, NULL, frame_kind,
             host_acked, NULL, NULL, created_at
      FROM runner_ipc_journal_v3
      ORDER BY frame_seq
    `);
    database.exec("DROP TABLE runner_ipc_journal_v3");
  }, { transactionLabel: "ipc_journal.migrate_v4" });
}

export function recordRunnerHostCallApplied(
  database: DatabaseSync,
  input: RunnerHostCallAppliedInput,
  options: RunnerSqliteTransactionOptions = {},
): Promise<void> {
  assertNonEmpty(input.correlationId, "runner host-call correlation id");
  assertNonEmpty(input.service, "runner host-call service");
  assertNonEmpty(input.operation, "runner host-call operation");
  assertNonEmpty(input.createdAt, "runner host-call created_at");
  return transaction(database, "record_host_call_applied", () => {
    const existing = readRow(database, input.correlationId);
    if (existing) {
      if (existing.service !== input.service || existing.operation !== input.operation) {
        throw new Error("runner host-call correlation id was reused for a different operation");
      }
      return;
    }
    database.prepare(`
      INSERT INTO runner_ipc_journal (
        outbox_source_seq, correlation_id, frame_kind, host_acked,
        service, operation, created_at
      ) VALUES (NULL, ?, 'host_call', 1, ?, ?, ?)
    `).run(input.correlationId, input.service, input.operation, input.createdAt);
  }, options);
}

export function readRunnerHostCallApplied(
  database: DatabaseSync,
  correlationId: string,
): RunnerHostCallApplied | null {
  assertNonEmpty(correlationId, "runner host-call correlation id");
  const row = readRow(database, correlationId);
  return row === null ? null : {
    correlationId: row.correlation_id,
    service: row.service,
    operation: row.operation,
  };
}

export function acknowledgeRunnerHostCall(
  database: DatabaseSync,
  correlationId: string,
  options: RunnerSqliteTransactionOptions = {},
): Promise<void> {
  assertNonEmpty(correlationId, "runner host-call correlation id");
  return transaction(database, "acknowledge_host_call", () => {
    database.prepare(`
      DELETE FROM runner_ipc_journal
      WHERE frame_kind = 'host_call' AND correlation_id = ?
    `).run(correlationId);
  }, options);
}

function readRow(
  database: DatabaseSync,
  correlationId: string,
): { correlation_id: string; service: string; operation: string } | null {
  const row = database.prepare(`
    SELECT correlation_id, service, operation
    FROM runner_ipc_journal
    WHERE frame_kind = 'host_call' AND correlation_id = ? AND host_acked = 1
  `).get(correlationId) as {
    correlation_id: string;
    service: string;
    operation: string;
  } | undefined;
  return row ?? null;
}

function transaction(
  database: DatabaseSync,
  transactionLabel: string,
  operation: () => void,
  options: RunnerSqliteTransactionOptions,
): Promise<void> {
  return withRunnerSqliteTransaction(database, operation, {
    ...options,
    transactionLabel: options.transactionLabel ?? transactionLabel,
  });
}

function tableHasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return columns.some((entry) => entry.name === column);
}

function assertNonEmpty(value: string, label: string): void {
  if (!value) throw new Error(`${label} required`);
}
