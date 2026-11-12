import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";


import {
  ensureRunnerSqliteWal,
  openRunnerSqliteDatabase,
  openRunnerSqliteReadOnlyDatabase,
  withRunnerSqliteTransactionSync,
  type RunnerSqliteTransactionObserver,
  type RunnerSqliteTransactionOptions,
} from "./runner_sqlite_connection.js";
import type { RunnerDatabaseObservationContext } from "./runner_phase_observation.js";

const RUNNER_HOST_STATE_SCHEMA_VERSION = 2;

const RUNNER_HOST_STATE_DDL = `
CREATE TABLE IF NOT EXISTS runner_event_ack_checkpoint (
  stream_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  acknowledged_through INTEGER NOT NULL CHECK (acknowledged_through >= 1),
  checkpoint_hash TEXT NOT NULL CHECK (
    length(checkpoint_hash) = 64 AND checkpoint_hash = lower(checkpoint_hash)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS runner_host_call_receipt (
  session_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, correlation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS runner_host_intervention_fallback (
  session_id TEXT NOT NULL,
  intervention_id TEXT NOT NULL,
  message_json TEXT NOT NULL,
  event_json TEXT,
  queued INTEGER NOT NULL CHECK (queued IN (0, 1)),
  staged_at TEXT NOT NULL,
  queued_at TEXT,
  PRIMARY KEY (session_id, intervention_id)
) STRICT;
`;

export interface RunnerHostCallAppliedReceipt {
  correlationId: string;
  service: string;
  operation: string;
}

export function runnerHostStatePath(runnerDatabasePath: string): string {
  return join(dirname(runnerDatabasePath), "runner-host.sqlite");
}

export interface RunnerHostStateStoreOptions {
  sessionId?: string;
  transactionObserver?: RunnerSqliteTransactionObserver;
}

export class RunnerHostStateStore {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly observation?: RunnerDatabaseObservationContext,
    private readonly sessionId?: string,
    private readonly transactionObserver?: RunnerSqliteTransactionObserver,
  ) {}

  static open(
    path: string,
    observation?: RunnerDatabaseObservationContext,
    options: RunnerHostStateStoreOptions = {},
  ): RunnerHostStateStore {
    const initialize = (): DatabaseSync => {
      const database = openRunnerSqliteDatabase(path, {});
      try {
        ensureRunnerSqliteWal(database);
        database.exec("PRAGMA synchronous = FULL");
        database.exec(RUNNER_HOST_STATE_DDL);
        const version = readUserVersion(database);
        if (version > RUNNER_HOST_STATE_SCHEMA_VERSION) {
          throw new Error(`runner host state schema version ${version} is not supported`);
        }
        if (version < RUNNER_HOST_STATE_SCHEMA_VERSION) {
          database.exec(`PRAGMA user_version = ${RUNNER_HOST_STATE_SCHEMA_VERSION}`);
        }
        chmodSync(path, 0o600);
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    };
    const database = observation
      ? observation.phaseObservation.runSync("dbOpen", {
        ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
        databasePath: path,
        ...(observation.label ? { label: observation.label } : {}),
      }, initialize)
      : initialize();
    return new RunnerHostStateStore(
      database,
      observation,
      options.sessionId ?? observation?.sessionId,
      options.transactionObserver,
    );
  }

  initializeEventCheckpoint(input: {
    streamId: string;
    sessionId: string;
    acknowledgedThrough: number;
  }): void {
    validateCheckpointInput(input);
    this.transaction("initialize_checkpoint", () => {
      const current = this.readCheckpointRow(input.streamId);
      if (current) {
        if (current.session_id !== input.sessionId) {
          throw new Error("runner host checkpoint stream is already owned by another session");
        }
        assertCheckpointHash(current);
        if (input.acknowledgedThrough <= current.acknowledged_through) return;
        this.updateCheckpoint(current, input.acknowledgedThrough);
        return;
      }
      this.database.prepare(`
        INSERT INTO runner_event_ack_checkpoint (
          stream_id, session_id, acknowledged_through, checkpoint_hash
        ) VALUES (?, ?, ?, ?)
      `).run(
        input.streamId,
        input.sessionId,
        input.acknowledgedThrough,
        checkpointHash(input.streamId, input.sessionId, input.acknowledgedThrough),
      );
    });
  }

  readAcknowledgedThrough(streamId: string, sessionId: string): number | null {
    validateIdentity(streamId, "runner host checkpoint stream id");
    validateIdentity(sessionId, "runner host checkpoint session id");
    return this.observedRead("runner_host.read_acknowledged_through", () => {
      const row = this.readCheckpointRow(streamId);
      if (!row) return null;
      if (row.session_id !== sessionId) {
        throw new Error("runner host checkpoint stream is owned by another session");
      }
      assertCheckpointHash(row);
      return row.acknowledged_through;
    });
  }

  acknowledgeEvent(input: {
    streamId: string;
    sessionId: string;
    acknowledgedThrough: number;
    latestDurableSourceSeq: number;
  }): void {
    validateCheckpointInput(input);
    if (
      !Number.isSafeInteger(input.latestDurableSourceSeq)
      || input.latestDurableSourceSeq < 1
    ) {
      throw new Error("runner host checkpoint latest durable source_seq is invalid");
    }
    if (input.acknowledgedThrough > input.latestDurableSourceSeq) {
      throw new Error("runner host ACK exceeds durable runner source_seq");
    }
    this.transaction("acknowledge_event", () => {
      const current = this.requireCheckpoint(input.streamId, input.sessionId);
      if (input.acknowledgedThrough <= current.acknowledged_through) return;
      this.updateCheckpoint(current, input.acknowledgedThrough);
    });
  }

  recordHostCallApplied(input: {
    sessionId: string;
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): void {
    validateIdentity(input.sessionId, "runner host receipt session id");
    validateIdentity(input.correlationId, "runner host receipt correlation id");
    validateIdentity(input.service, "runner host receipt service");
    validateIdentity(input.operation, "runner host receipt operation");
    if (!Number.isFinite(Date.parse(input.createdAt))) {
      throw new Error("runner host receipt created_at is invalid");
    }
    this.transaction("record_host_call_applied", () => {
      const current = this.readHostCallApplied(input.sessionId, input.correlationId);
      if (current) {
        if (current.service !== input.service || current.operation !== input.operation) {
          throw new Error("runner host-call correlation id was reused for a different operation");
        }
        return;
      }
      this.database.prepare(`
        INSERT INTO runner_host_call_receipt (
          session_id, correlation_id, service, operation, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.correlationId,
        input.service,
        input.operation,
        input.createdAt,
      );
    });
  }

  readHostCallApplied(
    sessionId: string,
    correlationId: string,
  ): RunnerHostCallAppliedReceipt | null {
    validateIdentity(sessionId, "runner host receipt session id");
    validateIdentity(correlationId, "runner host receipt correlation id");
    return this.observedRead("runner_host.read_host_call_applied", () => {
      const row = this.database.prepare(`
        SELECT correlation_id, service, operation
        FROM runner_host_call_receipt
        WHERE session_id = ? AND correlation_id = ?
      `).get(sessionId, correlationId) as {
        correlation_id: string;
        service: string;
        operation: string;
      } | undefined;
      return row
        ? { correlationId: row.correlation_id, service: row.service, operation: row.operation }
        : null;
    });
  }

  acknowledgeHostCall(sessionId: string, correlationId: string): void {
    validateIdentity(sessionId, "runner host receipt session id");
    validateIdentity(correlationId, "runner host receipt correlation id");
    this.transaction("acknowledge_host_call", () => {
      this.database.prepare(`
        DELETE FROM runner_host_call_receipt
        WHERE session_id = ? AND correlation_id = ?
      `).run(sessionId, correlationId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const close = () => this.database.close();
    if (!this.observation) {
      close();
      return;
    }
    this.observation.phaseObservation.runSync("dbClose", {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      label: "runner_host.close",
    }, close);
  }

  private readCheckpointRow(streamId: string): CheckpointRow | null {
    return (this.database.prepare(`
      SELECT stream_id, session_id, acknowledged_through, checkpoint_hash
      FROM runner_event_ack_checkpoint WHERE stream_id = ?
    `).get(streamId) as CheckpointRow | undefined) ?? null;
  }

  private requireCheckpoint(streamId: string, sessionId: string): CheckpointRow {
    const row = this.readCheckpointRow(streamId);
    if (!row) throw new Error("runner host ACK checkpoint is missing");
    if (row.session_id !== sessionId) {
      throw new Error("runner host checkpoint stream is owned by another session");
    }
    assertCheckpointHash(row);
    return row;
  }

  private updateCheckpoint(current: CheckpointRow, acknowledgedThrough: number): void {
    const nextHash = checkpointHash(
      current.stream_id,
      current.session_id,
      acknowledgedThrough,
    );
    const result = this.database.prepare(`
      UPDATE runner_event_ack_checkpoint
      SET acknowledged_through = ?, checkpoint_hash = ?
      WHERE stream_id = ? AND acknowledged_through = ? AND checkpoint_hash = ?
    `).run(
      acknowledgedThrough,
      nextHash,
      current.stream_id,
      current.acknowledged_through,
      current.checkpoint_hash,
    );
    if (Number(result.changes) !== 1) {
      throw new Error("runner host ACK checkpoint changed concurrently");
    }
  }

  private observedRead<T>(label: string, operation: () => T): T {
    if (!this.observation) return operation();
    return this.observation.phaseObservation.runSync("dbRead", {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      label,
    }, operation);
  }

  private transaction<T>(transactionLabel: string, operation: () => T): T {
    if (this.closed) throw new Error("runner host state store is closed");
    return withRunnerSqliteTransactionSync(
      this.database,
      operation,
      this.transactionOptions(transactionLabel),
    );
  }

  private transactionOptions(
    transactionLabel: string,
  ): Omit<RunnerSqliteTransactionOptions, "sleep" | "retryDelaysMs"> {
    return {
      transactionLabel: `runner_host.${transactionLabel}`,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.transactionObserver ? { observer: this.transactionObserver } : {}),
    };
  }
}

export function readRunnerHostAcknowledgedThrough(
  path: string,
  streamId: string,
  sessionId: string,
  observation?: RunnerDatabaseObservationContext,
): number | null {
  if (!existsSync(path)) return null;
  const database = openRunnerSqliteReadOnlyDatabase(path, observation);
  try {
    const read = () => {
      const row = database.prepare(`
        SELECT stream_id, session_id, acknowledged_through, checkpoint_hash
        FROM runner_event_ack_checkpoint WHERE stream_id = ?
      `).get(streamId) as CheckpointRow | undefined;
      if (!row) return null;
      if (row.session_id !== sessionId) {
        throw new Error("runner host checkpoint stream is owned by another session");
      }
      assertCheckpointHash(row);
      return row.acknowledged_through;
    };
    return observation
      ? observation.phaseObservation.runSync("dbRead", {
        sessionId,
        databasePath: path,
        label: observation.label ?? "runner host ACK",
      }, read)
      : read();
  } finally {
    database.close();
  }
}

type CheckpointRow = {
  stream_id: string;
  session_id: string;
  acknowledged_through: number;
  checkpoint_hash: string;
};

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function validateCheckpointInput(input: {
  streamId: string;
  sessionId: string;
  acknowledgedThrough: number;
}): void {
  validateIdentity(input.streamId, "runner host checkpoint stream id");
  validateIdentity(input.sessionId, "runner host checkpoint session id");
  if (!Number.isSafeInteger(input.acknowledgedThrough) || input.acknowledgedThrough < 1) {
    throw new Error("runner host checkpoint acknowledged_through is invalid");
  }
}

function validateIdentity(value: string, label: string): void {
  if (!value) throw new Error(`${label} is required`);
}

function checkpointHash(streamId: string, sessionId: string, acknowledgedThrough: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ streamId, sessionId, acknowledgedThrough }))
    .digest("hex");
}

function assertCheckpointHash(row: CheckpointRow): void {
  if (
    row.checkpoint_hash
    !== checkpointHash(row.stream_id, row.session_id, row.acknowledged_through)
  ) {
    throw new Error("runner host ACK checkpoint hash mismatch");
  }
}
