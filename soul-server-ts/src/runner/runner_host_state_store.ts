import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { compareInterventionPriority } from "../task/task_intervention_queue.js";

import {
  ensureRunnerSqliteWal,
  openRunnerSqliteDatabase,
  openRunnerSqliteReadOnlyDatabase,
  withRunnerSqliteTransactionSync,
} from "./runner_sqlite_connection.js";

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

export interface RunnerHostInterventionFallback {
  interventionId: string;
  message: Record<string, unknown>;
  event?: Record<string, unknown>;
  queued: boolean;
}

export function runnerHostStatePath(runnerDatabasePath: string): string {
  return join(dirname(runnerDatabasePath), "runner-host.sqlite");
}

export class RunnerHostStateStore {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
  ) {}

  static open(path: string): RunnerHostStateStore {
    const database = openRunnerSqliteDatabase(path);
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
      return new RunnerHostStateStore(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  initializeEventCheckpoint(input: {
    streamId: string;
    sessionId: string;
    acknowledgedThrough: number;
  }): void {
    validateCheckpointInput(input);
    this.transaction(() => {
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
    const row = this.readCheckpointRow(streamId);
    if (!row) return null;
    if (row.session_id !== sessionId) {
      throw new Error("runner host checkpoint stream is owned by another session");
    }
    assertCheckpointHash(row);
    return row.acknowledged_through;
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
    this.transaction(() => {
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
    this.transaction(() => {
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
  }

  acknowledgeHostCall(sessionId: string, correlationId: string): void {
    validateIdentity(sessionId, "runner host receipt session id");
    validateIdentity(correlationId, "runner host receipt correlation id");
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM runner_host_call_receipt
        WHERE session_id = ? AND correlation_id = ?
      `).run(sessionId, correlationId);
    });
  }

  stageInterventionFallback(input: {
    sessionId: string;
    interventionId: string;
    message: Record<string, unknown>;
    event?: Record<string, unknown>;
    queued: boolean;
    stagedAt: string;
  }): { queuePosition: number } {
    validateIdentity(input.sessionId, "runner host intervention session id");
    validateIdentity(input.interventionId, "runner host intervention id");
    if (!Number.isFinite(Date.parse(input.stagedAt))) {
      throw new Error("runner host intervention staged_at is invalid");
    }
    const messageJson = JSON.stringify(input.message);
    const eventJson = input.event === undefined ? null : JSON.stringify(input.event);
    return this.transaction(() => {
      const current = this.readInterventionFallbackRow(
        input.sessionId,
        input.interventionId,
      );
      if (current) {
        if (current.message_json !== messageJson || current.event_json !== eventJson) {
          throw new Error("runner host intervention id was reused with different content");
        }
        if (input.queued && current.queued === 0) {
          this.database.prepare(`
            UPDATE runner_host_intervention_fallback
            SET queued = 1, queued_at = ?
            WHERE session_id = ? AND intervention_id = ? AND queued = 0
          `).run(input.stagedAt, input.sessionId, input.interventionId);
        }
      } else {
        this.database.prepare(`
          INSERT INTO runner_host_intervention_fallback (
            session_id, intervention_id, message_json, event_json,
            queued, staged_at, queued_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.sessionId,
          input.interventionId,
          messageJson,
          eventJson,
          input.queued ? 1 : 0,
          input.stagedAt,
          input.queued ? input.stagedAt : null,
        );
      }
      return {
        queuePosition: input.queued
          ? this.fallbackQueuePosition(input.sessionId, input.interventionId)
          : 0,
      };
    });
  }

  readInterventionFallback(
    sessionId: string,
    interventionId: string,
  ): RunnerHostInterventionFallback | null {
    validateIdentity(sessionId, "runner host intervention session id");
    validateIdentity(interventionId, "runner host intervention id");
    const row = this.readInterventionFallbackRow(sessionId, interventionId);
    return row ? normalizeInterventionFallback(row) : null;
  }

  readPendingInterventionFallbacks(
    sessionId: string,
  ): RunnerHostInterventionFallback[] {
    validateIdentity(sessionId, "runner host intervention session id");
    const rows = this.database.prepare(`
      SELECT intervention_id, message_json, event_json, queued
      FROM runner_host_intervention_fallback
      WHERE session_id = ?
      ORDER BY COALESCE(queued_at, staged_at), intervention_id
    `).all(sessionId) as InterventionFallbackRow[];
    return rows.map(normalizeInterventionFallback).sort((left, right) =>
      compareInterventionPriority(left.message, right.message));
  }

  removeInterventionFallback(sessionId: string, interventionId: string): void {
    validateIdentity(sessionId, "runner host intervention session id");
    validateIdentity(interventionId, "runner host intervention id");
    this.transaction(() => {
      this.database.prepare(`
        DELETE FROM runner_host_intervention_fallback
        WHERE session_id = ? AND intervention_id = ?
      `).run(sessionId, interventionId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
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

  private readInterventionFallbackRow(
    sessionId: string,
    interventionId: string,
  ): InterventionFallbackRow | null {
    return (this.database.prepare(`
      SELECT intervention_id, message_json, event_json, queued
      FROM runner_host_intervention_fallback
      WHERE session_id = ? AND intervention_id = ?
    `).get(sessionId, interventionId) as InterventionFallbackRow | undefined) ?? null;
  }

  private fallbackQueuePosition(sessionId: string, interventionId: string): number {
    const position = this.readPendingInterventionFallbacks(sessionId)
      .filter((entry) => entry.queued)
      .findIndex((entry) => entry.interventionId === interventionId);
    return position < 0 ? 0 : position + 1;
  }

  private transaction<T>(operation: () => T): T {
    if (this.closed) throw new Error("runner host state store is closed");
    return withRunnerSqliteTransactionSync(this.database, operation);
  }
}

export function readRunnerHostAcknowledgedThrough(
  path: string,
  streamId: string,
  sessionId: string,
): number | null {
  if (!existsSync(path)) return null;
  const database = openRunnerSqliteReadOnlyDatabase(path);
  try {
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

type InterventionFallbackRow = {
  intervention_id: string;
  message_json: string;
  event_json: string | null;
  queued: number;
};

function normalizeInterventionFallback(
  row: InterventionFallbackRow,
): RunnerHostInterventionFallback {
  return {
    interventionId: row.intervention_id,
    message: JSON.parse(row.message_json) as Record<string, unknown>,
    ...(row.event_json === null
      ? {}
      : { event: JSON.parse(row.event_json) as Record<string, unknown> }),
    queued: row.queued === 1,
  };
}

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
