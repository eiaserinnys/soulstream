import { createRequire } from "node:module";

import type { DatabaseSync } from "node:sqlite";

import type { RunnerExecutionState } from "./sqlite_event_outbox_schema.js";
import { stringifyRunnerJson } from "./sqlite_event_outbox_records.js";

const { DatabaseSync: RuntimeDatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface RunnerLifecycleRecord {
  session_id: string;
  runner_pid: number;
  execution_command_id: string;
  execution_state: RunnerExecutionState;
  progress_seq: number;
  progress_at: string;
  terminal_error: { code: string; message: string } | null;
}

export interface BeginRunnerExecutionInput {
  pid: number;
  commandId: string;
  progressedAt: string;
}

/**
 * Operational lease stored on the bootstrap row. It is not domain state and
 * never participates in payload hashes, source_seq, or orch receipts.
 * A missing bootstrap means the backend identity is not durable yet; callers
 * must use the registered pid/config files only for that short startup window.
 */
export class RunnerSqliteLifecycle {
  private closed = false;

  private constructor(private readonly database: DatabaseSync) {}

  static open(databasePath: string): RunnerSqliteLifecycle {
    const database = new RuntimeDatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000");
    return new RunnerSqliteLifecycle(database);
  }

  read(): RunnerLifecycleRecord | null {
    this.requireOpen();
    const row = this.database.prepare(`
      SELECT session_id, runner_pid, execution_command_id, execution_state,
             progress_seq, progress_at, terminal_error_json
      FROM runner_event_outbox WHERE record_kind = 'bootstrap'
    `).get() as LifecycleRow | undefined;
    if (!row || row.runner_pid === null || row.execution_command_id === null
      || row.execution_state === null || row.progress_at === null) {
      return null;
    }
    return {
      session_id: row.session_id,
      runner_pid: row.runner_pid,
      execution_command_id: row.execution_command_id,
      execution_state: row.execution_state,
      progress_seq: row.progress_seq,
      progress_at: row.progress_at,
      terminal_error: row.terminal_error_json === null
        ? null
        : JSON.parse(row.terminal_error_json) as { code: string; message: string },
    };
  }

  begin(input: BeginRunnerExecutionInput): RunnerLifecycleRecord {
    validatePositiveInteger(input.pid, "runner pid");
    if (!input.commandId) throw new Error("runner execution command id required");
    validateTimestamp(input.progressedAt, "runner progress timestamp");
    this.updateBootstrap(`
      runner_pid = ?, execution_command_id = ?, execution_state = 'running',
      progress_seq = progress_seq + 1, progress_at = ?, terminal_error_json = NULL
    `, [input.pid, input.commandId, input.progressedAt]);
    return this.requireLifecycle();
  }

  progress(commandId: string, progressedAt: string): RunnerLifecycleRecord {
    validateTimestamp(progressedAt, "runner progress timestamp");
    this.updateActive(commandId, `
      progress_seq = progress_seq + 1, progress_at = ?
    `, [progressedAt]);
    return this.requireLifecycle();
  }

  finish(
    commandId: string,
    state: "completed" | "failed" | "closed",
    progressedAt: string,
    error: { code: string; message: string } | null = null,
  ): RunnerLifecycleRecord {
    validateTimestamp(progressedAt, "runner progress timestamp");
    if (state === "failed" && error === null) {
      throw new Error("failed runner execution requires terminal error");
    }
    const terminalError = error === null
      ? null
      : stringifyRunnerJson(error, "terminal runner error");
    this.updateActive(commandId, `
      execution_state = ?, progress_seq = progress_seq + 1,
      progress_at = ?, terminal_error_json = ?
    `, [state, progressedAt, terminalError]);
    return this.requireLifecycle();
  }

  reap(commandId: string, progressedAt: string, error: {
    code: string;
    message: string;
  }): RunnerLifecycleRecord {
    validateTimestamp(progressedAt, "runner progress timestamp");
    this.updateActive(commandId, `
      execution_state = 'reaped', progress_seq = progress_seq + 1,
      progress_at = ?, terminal_error_json = ?
    `, [progressedAt, stringifyRunnerJson(error, "runner reap error")]);
    return this.requireLifecycle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private updateActive(commandId: string, assignments: string, args: SqlParameter[]): void {
    if (!commandId) throw new Error("runner execution command id required");
    const result = this.database.prepare(`
      UPDATE runner_event_outbox SET ${assignments}
      WHERE record_kind = 'bootstrap' AND execution_command_id = ?
    `).run(...args, commandId);
    if (result.changes !== 1) {
      throw new Error(`runner lifecycle command mismatch: ${commandId}`);
    }
  }

  private updateBootstrap(assignments: string, args: SqlParameter[]): void {
    this.requireOpen();
    const result = this.database.prepare(`
      UPDATE runner_event_outbox SET ${assignments}
      WHERE record_kind = 'bootstrap'
    `).run(...args);
    if (result.changes !== 1) {
      throw new Error("runner bootstrap required before lifecycle update");
    }
  }

  private requireLifecycle(): RunnerLifecycleRecord {
    const lifecycle = this.read();
    if (!lifecycle) throw new Error("runner lifecycle record unavailable");
    return lifecycle;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("runner lifecycle store is closed");
  }
}

export function ensureRunnerLifecycleColumns(database: DatabaseSync): void {
  const existing = new Set((database.prepare(
    "PRAGMA table_info(runner_event_outbox)",
  ).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, declaration] of LIFECYCLE_COLUMNS) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE runner_event_outbox ADD COLUMN ${name} ${declaration}`);
    }
  }
}

const LIFECYCLE_COLUMNS = [
  ["runner_pid", "INTEGER"],
  ["execution_command_id", "TEXT"],
  ["execution_state", "TEXT CHECK (execution_state IS NULL OR execution_state IN ('running', 'completed', 'failed', 'reaped', 'closed'))"],
  ["progress_seq", "INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0)"],
  ["progress_at", "TEXT"],
  ["terminal_error_json", "TEXT CHECK (terminal_error_json IS NULL OR json_valid(terminal_error_json))"],
] as const;

type LifecycleRow = {
  session_id: string;
  runner_pid: number | null;
  execution_command_id: string | null;
  execution_state: RunnerExecutionState | null;
  progress_seq: number;
  progress_at: string | null;
  terminal_error_json: string | null;
};

type SqlParameter = string | number | null;

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} invalid`);
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} invalid`);
}
