import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadNodeSqlite } from "./node_sqlite.js";
import type { RunnerExecutionState } from "./sqlite_event_outbox_schema.js";
import { stringifyRunnerJson } from "./sqlite_event_outbox_records.js";

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

const LIFECYCLE_SUMMARY_FILE = "runner-lifecycle.json";

export function runnerLifecycleSummaryPath(databasePath: string): string {
  return join(dirname(databasePath), LIFECYCLE_SUMMARY_FILE);
}

export async function readRunnerLifecycleSummary(
  databasePath: string,
): Promise<RunnerLifecycleRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runnerLifecycleSummaryPath(databasePath), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return validateLifecycleSummary(parsed);
}

/**
 * Operational lease stored on the bootstrap row. It is not domain state and
 * never participates in payload hashes, source_seq, or orch receipts.
 * A missing bootstrap means the backend identity is not durable yet; callers
 * must use the registered pid/config files only for that short startup window.
 */
export class RunnerSqliteLifecycle {
  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    private readonly databaseFilePath: string,
    private readonly sessionId?: string,
  ) {}

  static open(databasePath: string, sessionId?: string): RunnerSqliteLifecycle {
    const { DatabaseSync } = loadNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000");
    return new RunnerSqliteLifecycle(database, databasePath, sessionId);
  }

  read(): RunnerLifecycleRecord | null {
    this.requireOpen();
    const row = this.database.prepare(`
      SELECT session_id, runner_pid, execution_command_id, execution_state,
             progress_seq, progress_at, terminal_error_json
      FROM runner_event_outbox WHERE record_kind = 'bootstrap'
    `).get() as LifecycleRow | undefined;
    if (row && row.runner_pid !== null && row.execution_command_id !== null
      && row.execution_state !== null && row.progress_at !== null) {
      return lifecycleRecord(row);
    }
    const prebootstrap = this.database.prepare(`
      SELECT session_id, runner_pid, execution_command_id, execution_state,
             progress_seq, progress_at, terminal_error_json
      FROM runner_prebootstrap_lifecycle WHERE singleton = 1
    `).get() as LifecycleRow | undefined;
    return prebootstrap ? lifecycleRecord(prebootstrap) : null;
  }

  begin(input: BeginRunnerExecutionInput): RunnerLifecycleRecord {
    validatePositiveInteger(input.pid, "runner pid");
    if (!input.commandId) throw new Error("runner execution command id required");
    validateTimestamp(input.progressedAt, "runner progress timestamp");
    const bootstrap = this.database.prepare(`
      SELECT 1 FROM runner_event_outbox WHERE record_kind = 'bootstrap'
    `).get();
    if (!bootstrap) {
      if (!this.sessionId) {
        throw new Error("runner session id required before bootstrap lifecycle");
      }
      this.database.prepare(`
        INSERT INTO runner_prebootstrap_lifecycle (
          singleton, session_id, runner_pid, execution_command_id,
          execution_state, progress_seq, progress_at, terminal_error_json
        ) VALUES (1, ?, ?, ?, 'running', 1, ?, NULL)
        ON CONFLICT(singleton) DO UPDATE SET
          session_id = excluded.session_id,
          runner_pid = excluded.runner_pid,
          execution_command_id = excluded.execution_command_id,
          execution_state = 'running',
          progress_seq = runner_prebootstrap_lifecycle.progress_seq + 1,
          progress_at = excluded.progress_at,
          terminal_error_json = NULL
      `).run(this.sessionId, input.pid, input.commandId, input.progressedAt);
      return this.persistSummary(this.requireLifecycle());
    }

    const pending = this.database.prepare(`
      SELECT session_id, runner_pid, execution_command_id, execution_state,
             progress_seq, progress_at, terminal_error_json
      FROM runner_prebootstrap_lifecycle WHERE singleton = 1
    `).get() as LifecycleRow | undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (pending?.execution_command_id === input.commandId) {
        this.database.prepare(`
          UPDATE runner_event_outbox SET
            runner_pid = ?, execution_command_id = ?, execution_state = ?,
            progress_seq = ?, progress_at = ?, terminal_error_json = ?
          WHERE record_kind = 'bootstrap'
        `).run(
          pending.runner_pid,
          pending.execution_command_id,
          pending.execution_state,
          pending.progress_seq,
          pending.progress_at,
          pending.terminal_error_json,
        );
      } else {
        this.updateBootstrap(`
          runner_pid = ?, execution_command_id = ?, execution_state = 'running',
          progress_seq = progress_seq + 1, progress_at = ?, terminal_error_json = NULL
        `, [input.pid, input.commandId, input.progressedAt]);
      }
      this.database.prepare(
        "DELETE FROM runner_prebootstrap_lifecycle WHERE singleton = 1",
      ).run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.persistSummary(this.requireLifecycle());
  }

  progress(commandId: string, progressedAt: string): RunnerLifecycleRecord {
    validateTimestamp(progressedAt, "runner progress timestamp");
    this.updateActive(commandId, `
      progress_seq = progress_seq + 1, progress_at = ?
    `, [progressedAt]);
    return this.persistSummary(this.requireLifecycle());
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
    return this.persistSummary(this.requireLifecycle());
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
    return this.persistSummary(this.requireLifecycle());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private updateActive(commandId: string, assignments: string, args: SqlParameter[]): void {
    if (!commandId) throw new Error("runner execution command id required");
    let result = this.database.prepare(`
      UPDATE runner_event_outbox SET ${assignments}
      WHERE record_kind = 'bootstrap' AND execution_command_id = ?
    `).run(...args, commandId);
    if (result.changes === 0) {
      result = this.database.prepare(`
        UPDATE runner_prebootstrap_lifecycle SET ${assignments}
        WHERE singleton = 1 AND execution_command_id = ?
      `).run(...args, commandId);
    }
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

  private persistSummary(lifecycle: RunnerLifecycleRecord): RunnerLifecycleRecord {
    const path = runnerLifecycleSummaryPath(this.databaseFilePath);
    const temporaryPath = `${path}.tmp-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(lifecycle)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, path);
    return lifecycle;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("runner lifecycle store is closed");
  }
}

function lifecycleRecord(row: LifecycleRow): RunnerLifecycleRecord {
  if (row.runner_pid === null || row.execution_command_id === null
    || row.execution_state === null || row.progress_at === null) {
    throw new Error("runner lifecycle row incomplete");
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

function validateLifecycleSummary(value: unknown): RunnerLifecycleRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("runner lifecycle summary invalid");
  }
  const record = value as Partial<RunnerLifecycleRecord>;
  if (
    typeof record.session_id !== "string"
    || !record.session_id
    || !Number.isSafeInteger(record.runner_pid)
    || (record.runner_pid ?? 0) <= 0
    || typeof record.execution_command_id !== "string"
    || !record.execution_command_id
    || !["running", "completed", "failed", "reaped", "closed"].includes(
      record.execution_state ?? "",
    )
    || !Number.isSafeInteger(record.progress_seq)
    || (record.progress_seq ?? -1) < 0
    || typeof record.progress_at !== "string"
    || !Number.isFinite(Date.parse(record.progress_at))
    || !(record.terminal_error === null
      || (typeof record.terminal_error === "object"
        && typeof record.terminal_error?.code === "string"
        && typeof record.terminal_error?.message === "string"))
  ) throw new Error("runner lifecycle summary invalid");
  return record as RunnerLifecycleRecord;
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
