import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  RunnerLifecycleSummaryWriter,
  type RunnerSqliteLifecycleOptions,
} from "./runner_lifecycle_summary_writer.js";
import {
  openRunnerSqliteDatabase,
  openRunnerSqliteReadOnlyDatabase,
  requireRunnerSqliteWal,
  withRunnerSqliteTransactionSync,
} from "./runner_sqlite_connection.js";
import type { RunnerDatabaseObservationContext } from "./runner_phase_observation.js";
import {
  readRunnerLifecycleRecord,
  validateLifecycleSummary,
  type RunnerLifecycleRecord,
} from "./runner_lifecycle_record.js";
import { stringifyRunnerJson } from "./sqlite_event_outbox_records.js";
import { decideRunnerLifecycleStep } from "./state/runner_lifecycle_decision.js";
import type { RunnerLifecycleStep } from "./state/runner_lifecycle_machine.js";

export type { RunnerSqliteLifecycleOptions } from "./runner_lifecycle_summary_writer.js";
export type { RunnerInFlightTool, RunnerLifecycleRecord } from "./runner_lifecycle_record.js";
export { ensureRunnerLifecycleColumns } from "./sqlite_runner_lifecycle_schema.js";

export class RunnerLifecycleCommandMismatchError extends Error {
  constructor(commandId: string) {
    super(`runner lifecycle command mismatch: ${commandId}`);
    this.name = "RunnerLifecycleCommandMismatchError";
  }
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

export function readRunnerSqliteLifecycle(
  databasePath: string,
  observation?: RunnerDatabaseObservationContext,
): RunnerLifecycleRecord | null {
  const databaseObservation = observation
    ? {
      ...observation,
      databasePath,
      label: observation.label ?? "runner lifecycle",
    }
    : undefined;
  const database = openRunnerSqliteReadOnlyDatabase(databasePath, databaseObservation);
  try {
    const read = () => readRunnerLifecycleRecord(database);
    return databaseObservation
      ? databaseObservation.phaseObservation.runSync("dbRead", {
        ...(databaseObservation.sessionId
          ? { sessionId: databaseObservation.sessionId }
          : {}),
        databasePath,
        ...(databaseObservation.label ? { label: databaseObservation.label } : {}),
      }, read)
      : read();
  } finally {
    database.close();
  }
}

/**
 * Operational lease stored on the bootstrap row. It is not domain state and
 * never participates in payload hashes, source_seq, or orch receipts.
 * A missing bootstrap means the backend identity is not durable yet; callers
 * must use the registered pid/config files only for that short startup window.
 */
export class RunnerSqliteLifecycle {
  private closed = false;
  private readonly summaryWriter: RunnerLifecycleSummaryWriter;

  private constructor(
    private readonly database: DatabaseSync,
    databaseFilePath: string,
    private readonly sessionId?: string,
    options: RunnerSqliteLifecycleOptions = {},
  ) {
    this.summaryWriter = new RunnerLifecycleSummaryWriter(
      runnerLifecycleSummaryPath(databaseFilePath),
      options,
    );
  }

  static open(
    databasePath: string,
    sessionId?: string,
    options: RunnerSqliteLifecycleOptions = {},
  ): RunnerSqliteLifecycle {
    const database = openRunnerSqliteDatabase(databasePath);
    try {
      requireRunnerSqliteWal(database);
      return new RunnerSqliteLifecycle(database, databasePath, sessionId, options);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  read(): RunnerLifecycleRecord | null {
    this.requireOpen();
    return readRunnerLifecycleRecord(this.database);
  }

  begin(input: BeginRunnerExecutionInput): RunnerLifecycleRecord {
    validatePositiveInteger(input.pid, "runner pid");
    if (!input.commandId) throw new Error("runner execution command id required");
    validateTimestamp(input.progressedAt, "runner progress timestamp");
    this.transaction("lifecycle.begin", () => this.beginWithinTransaction(input));
    return this.persistSummary(this.requireLifecycle());
  }

  progress(commandId: string, progressedAt: string): RunnerLifecycleRecord {
    validateTimestamp(progressedAt, "runner progress timestamp");
    this.transaction("lifecycle.progress", () => {
      this.updateActiveWithinTransaction("progress", commandId, `
        progress_seq = progress_seq + 1, progress_at = ?, liveness_at = ?
      `, [progressedAt, progressedAt]);
    });
    return this.persistSummary(this.requireLifecycle());
  }

  liveness(commandId: string, observedAt: string): RunnerLifecycleRecord {
    validateTimestamp(observedAt, "runner liveness timestamp");
    this.transaction("lifecycle.liveness", () => {
      this.updateActiveWithinTransaction("liveness", commandId, "liveness_at = ?", [observedAt]);
    });
    return this.persistSummary(this.requireLifecycle());
  }

  toolStarted(
    commandId: string,
    toolUseId: string,
    progressedAt: string,
  ): RunnerLifecycleRecord {
    return this.updateToolLease(commandId, toolUseId, progressedAt, true);
  }

  toolFinished(
    commandId: string,
    toolUseId: string,
    progressedAt: string,
  ): RunnerLifecycleRecord {
    return this.updateToolLease(commandId, toolUseId, progressedAt, false);
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
    this.transaction("lifecycle.finish", () => {
      finishRunnerExecutionWithinTransaction(this.database, {
        commandId,
        state,
        progressedAt,
        terminalError: error,
      });
    });
    return this.persistSummary(this.requireLifecycle());
  }

  syncSummary(): RunnerLifecycleRecord | null {
    const lifecycle = this.read();
    return lifecycle === null ? null : this.persistSummary(lifecycle);
  }

  reap(commandId: string, progressedAt: string, error: {
    code: string;
    message: string;
  }): RunnerLifecycleRecord {
    validateTimestamp(progressedAt, "runner progress timestamp");
    this.transaction("lifecycle.reap", () => {
      this.updateActiveWithinTransaction("reap", commandId, `
        execution_state = 'reaped', progress_seq = progress_seq + 1,
        progress_at = ?, liveness_at = ?, in_flight_tools_json = '[]',
        terminal_error_json = ?
      `, [
        progressedAt,
        progressedAt,
        stringifyRunnerJson(error, "runner reap error"),
      ]);
    });
    return this.persistSummary(this.requireLifecycle());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private beginWithinTransaction(input: BeginRunnerExecutionInput): void {
    const bootstrap = this.database.prepare(`
      SELECT 1 FROM runner_event_outbox WHERE record_kind = 'bootstrap'
    `).get();
    if (!bootstrap) {
      if (!this.sessionId) {
        throw new Error("runner session id required before bootstrap lifecycle");
      }
      const sessionId = this.sessionId;
      this.database.prepare(`
        INSERT INTO runner_prebootstrap_lifecycle (
          singleton, session_id, runner_pid, execution_command_id,
          execution_state, progress_seq, progress_at, liveness_at,
          in_flight_tools_json, terminal_error_json
        ) VALUES (1, ?, ?, ?, 'running', 1, ?, ?, '[]', NULL)
        ON CONFLICT(singleton) DO UPDATE SET
          session_id = excluded.session_id,
          runner_pid = excluded.runner_pid,
          execution_command_id = excluded.execution_command_id,
          execution_state = 'running',
          progress_seq = runner_prebootstrap_lifecycle.progress_seq + 1,
          progress_at = excluded.progress_at,
          liveness_at = excluded.liveness_at,
          in_flight_tools_json = '[]',
          terminal_error_json = NULL
      `).run(
        sessionId,
        input.pid,
        input.commandId,
        input.progressedAt,
        input.progressedAt,
      );
      return;
    }

    const pending = this.database.prepare(`
      SELECT session_id, runner_pid, execution_command_id, execution_state,
             progress_seq, progress_at, liveness_at, in_flight_tools_json,
             terminal_error_json
      FROM runner_prebootstrap_lifecycle WHERE singleton = 1
    `).get() as PendingLifecycleRow | undefined;
    if (pending?.execution_command_id === input.commandId) {
      this.database.prepare(`
        UPDATE runner_event_outbox SET
          runner_pid = ?, execution_command_id = ?, execution_state = ?,
          progress_seq = ?, progress_at = ?, liveness_at = ?,
          in_flight_tools_json = ?, terminal_error_json = ?
        WHERE record_kind = 'bootstrap'
      `).run(
        pending.runner_pid,
        pending.execution_command_id,
        pending.execution_state,
        pending.progress_seq,
        pending.progress_at,
        pending.liveness_at ?? pending.progress_at,
        pending.in_flight_tools_json ?? "[]",
        pending.terminal_error_json,
      );
    } else {
      this.updateBootstrapWithinTransaction(`
        runner_pid = ?, execution_command_id = ?, execution_state = 'running',
        progress_seq = progress_seq + 1, progress_at = ?, liveness_at = ?,
        in_flight_tools_json = '[]', terminal_error_json = NULL
      `, [input.pid, input.commandId, input.progressedAt, input.progressedAt]);
    }
    this.database.prepare(
      "DELETE FROM runner_prebootstrap_lifecycle WHERE singleton = 1",
    ).run();
  }

  private updateActiveWithinTransaction(
    step: RunnerLifecycleStep,
    commandId: string,
    assignments: string,
    args: SqlParameter[],
  ): "applied" | "ignored" {
    if (!commandId) throw new Error("runner execution command id required");
    const lifecycle = this.read();
    const decision = decideRunnerLifecycleStep(
      lifecycle?.execution_state ?? "none",
      step,
      lifecycle?.execution_command_id === commandId,
    );
    if (decision === "reject") {
      throw new RunnerLifecycleCommandMismatchError(commandId);
    }
    if (decision === "ignore") return "ignored";
    this.applyActiveWithinTransaction(commandId, assignments, args);
    return "applied";
  }

  private applyActiveWithinTransaction(
    commandId: string,
    assignments: string,
    args: SqlParameter[],
  ): void {
    let result = this.database.prepare(`
      UPDATE runner_event_outbox SET ${assignments}
      WHERE record_kind = 'bootstrap' AND execution_command_id = ?
        AND execution_state = 'running'
    `).run(...args, commandId);
    if (result.changes === 0) {
      result = this.database.prepare(`
        UPDATE runner_prebootstrap_lifecycle SET ${assignments}
        WHERE singleton = 1 AND execution_command_id = ?
          AND execution_state = 'running'
      `).run(...args, commandId);
    }
    if (result.changes !== 1) {
      throw new RunnerLifecycleCommandMismatchError(commandId);
    }
  }

  private updateToolLease(
    commandId: string,
    toolUseId: string,
    progressedAt: string,
    started: boolean,
  ): RunnerLifecycleRecord {
    if (!toolUseId) throw new Error("runner tool use id required");
    validateTimestamp(progressedAt, "runner progress timestamp");
    this.transaction(started ? "lifecycle.tool_started" : "lifecycle.tool_finished", () => {
      const current = this.requireLifecycle();
      const decision = decideRunnerLifecycleStep(
        current.execution_state,
        started ? "tool_started" : "tool_finished",
        current.execution_command_id === commandId,
      );
      if (decision === "reject") {
        throw new RunnerLifecycleCommandMismatchError(commandId);
      }
      if (decision === "ignore") return;
      const tools = new Map(current.in_flight_tools.map((tool) => [tool.tool_use_id, tool]));
      if (started) {
        // Duplicate delivery must not extend the tool's absolute recovery lease.
        if (tools.has(toolUseId)) return;
        tools.set(toolUseId, { tool_use_id: toolUseId, started_at: progressedAt });
      } else {
        tools.delete(toolUseId);
      }
      this.applyActiveWithinTransaction(commandId, `
        progress_seq = progress_seq + 1, progress_at = ?, liveness_at = ?,
        in_flight_tools_json = ?
      `, [
        progressedAt,
        progressedAt,
        stringifyRunnerJson(
          [...tools.values()].sort((left, right) => left.tool_use_id.localeCompare(right.tool_use_id)),
          "runner in-flight tools",
        ),
      ]);
    });
    return this.persistSummary(this.requireLifecycle());
  }

  private updateBootstrapWithinTransaction(assignments: string, args: SqlParameter[]): void {
    const result = this.database.prepare(`
      UPDATE runner_event_outbox SET ${assignments}
      WHERE record_kind = 'bootstrap'
    `).run(...args);
    if (result.changes !== 1) {
      throw new Error("runner bootstrap required before lifecycle update");
    }
  }

  private transaction<T>(transactionLabel: string, operation: () => T): T {
    this.requireOpen();
    return withRunnerSqliteTransactionSync(this.database, operation, {
      transactionLabel,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
  }

  private requireLifecycle(): RunnerLifecycleRecord {
    const lifecycle = this.read();
    if (!lifecycle) throw new Error("runner lifecycle record unavailable");
    return lifecycle;
  }

  private persistSummary(lifecycle: RunnerLifecycleRecord): RunnerLifecycleRecord {
    this.summaryWriter.write(lifecycle);
    return lifecycle;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("runner lifecycle store is closed");
  }
}

export type RunnerFinishOutcome = "applied" | "ignored";

/**
 * 끝남의 한 길이다. running이고 실행 명령 번호가 같을 때만 적용한다.
 * closed나 reaped에 온 늦은 끝남은 무시하고 ignored를 돌려준다.
 */
export function finishRunnerExecutionWithinTransaction(
  database: DatabaseSync,
  input: {
    commandId: string;
    state: "completed" | "failed" | "closed";
    progressedAt: string;
    terminalError: { code: string; message: string } | null;
  },
): RunnerFinishOutcome {
  if (!input.commandId) throw new Error("runner execution command id required");
  validateTimestamp(input.progressedAt, "runner progress timestamp");
  if (input.state === "failed" && input.terminalError === null) {
    throw new Error("failed runner execution requires terminal error");
  }
  const lifecycle = readRunnerLifecycleRecord(database);
  const step: RunnerLifecycleStep = input.state === "completed"
    ? "finish_completed"
    : input.state === "failed"
      ? "finish_failed"
      : "finish_closed";
  const decision = decideRunnerLifecycleStep(
    lifecycle?.execution_state ?? "none",
    step,
    lifecycle?.execution_command_id === input.commandId,
  );
  if (decision === "ignore") return "ignored";
  if (decision === "reject") {
    throw new Error(`runner lifecycle command mismatch: ${input.commandId}`);
  }
  const terminalError = input.terminalError === null
    ? null
    : stringifyRunnerJson(input.terminalError, "terminal runner error");
  let result = database.prepare(`
    UPDATE runner_event_outbox SET
      execution_state = ?, progress_seq = progress_seq + 1,
      progress_at = ?, liveness_at = ?, in_flight_tools_json = '[]',
      terminal_error_json = ?
    WHERE record_kind = 'bootstrap' AND execution_command_id = ?
      AND execution_state = 'running'
  `).run(
    input.state,
    input.progressedAt,
    input.progressedAt,
    terminalError,
    input.commandId,
  );
  if (result.changes === 0) {
    result = database.prepare(`
      UPDATE runner_prebootstrap_lifecycle SET
        execution_state = ?, progress_seq = progress_seq + 1,
        progress_at = ?, liveness_at = ?, in_flight_tools_json = '[]',
        terminal_error_json = ?
      WHERE singleton = 1 AND execution_command_id = ?
        AND execution_state = 'running'
    `).run(
      input.state,
      input.progressedAt,
      input.progressedAt,
      terminalError,
      input.commandId,
    );
  }
  if (result.changes !== 1) {
    throw new Error(`runner lifecycle command mismatch: ${input.commandId}`);
  }
  return "applied";
}

type PendingLifecycleRow = {
  session_id: string;
  runner_pid: number | null;
  execution_command_id: string;
  execution_state: RunnerLifecycleRecord["execution_state"];
  progress_seq: number;
  progress_at: string;
  liveness_at: string | null;
  in_flight_tools_json: string | null;
  terminal_error_json: string | null;
};

type SqlParameter = string | number | null;

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} invalid`);
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} invalid`);
}
