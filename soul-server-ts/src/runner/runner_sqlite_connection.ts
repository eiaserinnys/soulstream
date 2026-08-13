import type { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

import { loadNodeSqlite } from "./node_sqlite.js";

export const RUNNER_SQLITE_BUSY_TIMEOUT_MS = 25;
export const RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS = [50, 200] as const;

export interface RunnerSqliteOpenOptions {
  readOnly?: boolean;
}

export interface RunnerSqliteBusyRetryOptions {
  sleep?: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

export type RunnerSqliteTransactionStage =
  | "begin"
  | "operation"
  | "commit"
  | "rollback"
  | "retry_wait"
  | "completed"
  | "failed";

export interface RunnerSqliteTransactionEvent {
  transactionId: string;
  transactionLabel: string;
  sessionId?: string;
  attempt: number;
  stage: RunnerSqliteTransactionStage;
  startedAtMonoMs: number;
  attemptStartedAtMonoMs: number;
  observedAtMonoMs: number;
  elapsedMs: number;
  attemptElapsedMs: number;
  retryDelayMs?: number;
  errorCode?: string;
}

export type RunnerSqliteTransactionObserver = (
  event: RunnerSqliteTransactionEvent,
) => void;

export interface RunnerSqliteTransactionOptions extends RunnerSqliteBusyRetryOptions {
  transactionLabel?: string;
  sessionId?: string;
  observer?: RunnerSqliteTransactionObserver;
}

let transactionSequence = 0;
let transactionObserverFailureWarned = false;

export function openRunnerSqliteDatabase(
  databasePath: string,
  options: RunnerSqliteOpenOptions = {},
): DatabaseSync {
  const { DatabaseSync } = loadNodeSqlite();
  const database = new DatabaseSync(databasePath, {
    readOnly: options.readOnly ?? false,
  });
  try {
    database.exec(`PRAGMA busy_timeout = ${RUNNER_SQLITE_BUSY_TIMEOUT_MS}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openRunnerSqliteReadOnlyDatabase(databasePath: string): DatabaseSync {
  const database = openRunnerSqliteDatabase(databasePath, { readOnly: true });
  try {
    requireRunnerSqliteWal(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function ensureRunnerSqliteWal(database: DatabaseSync): void {
  const current = readJournalMode(database);
  if (current === "wal") return;
  const configured = database.prepare("PRAGMA journal_mode = WAL").get() as {
    journal_mode: string;
  };
  if (configured.journal_mode.toLowerCase() !== "wal") {
    throw new Error("runner event outbox requires SQLite WAL journal mode");
  }
}

export function requireRunnerSqliteWal(database: DatabaseSync): void {
  if (readJournalMode(database) !== "wal") {
    throw new Error("runner event outbox requires SQLite WAL journal mode");
  }
}

export async function withRunnerSqliteBusyRetry<T>(
  operation: () => T,
  options: RunnerSqliteBusyRetryOptions = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepAsync;
  let retryIndex = 0;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isRunnerSqliteBusyError(error) || retryIndex >= retryDelaysMs.length) {
        throw error;
      }
      await sleep(retryDelaysMs[retryIndex]!);
      retryIndex += 1;
    }
  }
}

export async function withRunnerSqliteTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: RunnerSqliteTransactionOptions = {},
): Promise<T> {
  const transactionId = `${process.pid}:${++transactionSequence}`;
  const startedAtMonoMs = performance.now();
  const retryDelaysMs = options.retryDelaysMs ?? RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS;
  let attempt = 0;
  return await withRunnerSqliteBusyRetry(() => {
    attempt += 1;
    const attemptStartedAtMonoMs = performance.now();
    let transactionOpen = false;
    try {
      observeTransaction(
        options,
        transactionId,
        attempt,
        "begin",
        startedAtMonoMs,
        attemptStartedAtMonoMs,
      );
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      observeTransaction(
        options,
        transactionId,
        attempt,
        "operation",
        startedAtMonoMs,
        attemptStartedAtMonoMs,
      );
      const result = operation();
      observeTransaction(
        options,
        transactionId,
        attempt,
        "commit",
        startedAtMonoMs,
        attemptStartedAtMonoMs,
      );
      database.exec("COMMIT");
      transactionOpen = false;
      observeTransaction(
        options,
        transactionId,
        attempt,
        "completed",
        startedAtMonoMs,
        attemptStartedAtMonoMs,
      );
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          observeTransaction(
            options,
            transactionId,
            attempt,
            "rollback",
            startedAtMonoMs,
            attemptStartedAtMonoMs,
          );
          database.exec("ROLLBACK");
        } catch {
          // Preserve the initiating SQLite error; retry classification depends on it.
        }
      }
      const retryDelayMs = retryDelaysMs[attempt - 1];
      const willRetry = isRunnerSqliteBusyError(error) && retryDelayMs !== undefined;
      observeTransaction(
        options,
        transactionId,
        attempt,
        willRetry ? "retry_wait" : "failed",
        startedAtMonoMs,
        attemptStartedAtMonoMs,
        {
          ...(willRetry ? { retryDelayMs } : {}),
          errorCode: readErrorCode(error),
        },
      );
      throw error;
    }
  }, { ...options, retryDelaysMs });
}

export function withRunnerSqliteTransactionSync<T>(
  database: DatabaseSync,
  operation: () => T,
  options: Omit<RunnerSqliteTransactionOptions, "sleep" | "retryDelaysMs"> = {},
): T {
  const transactionId = `${process.pid}:${++transactionSequence}`;
  const startedAtMonoMs = performance.now();
  const attemptStartedAtMonoMs = startedAtMonoMs;
  let transactionOpen = false;
  try {
    observeTransaction(options, transactionId, 1, "begin", startedAtMonoMs, attemptStartedAtMonoMs);
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    observeTransaction(
      options,
      transactionId,
      1,
      "operation",
      startedAtMonoMs,
      attemptStartedAtMonoMs,
    );
    const result = operation();
    observeTransaction(options, transactionId, 1, "commit", startedAtMonoMs, attemptStartedAtMonoMs);
    database.exec("COMMIT");
    transactionOpen = false;
    observeTransaction(
      options,
      transactionId,
      1,
      "completed",
      startedAtMonoMs,
      attemptStartedAtMonoMs,
    );
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        observeTransaction(
          options,
          transactionId,
          1,
          "rollback",
          startedAtMonoMs,
          attemptStartedAtMonoMs,
        );
        database.exec("ROLLBACK");
      } catch {
        // Preserve the initiating SQLite error.
      }
    }
    observeTransaction(
      options,
      transactionId,
      1,
      "failed",
      startedAtMonoMs,
      attemptStartedAtMonoMs,
      { errorCode: readErrorCode(error) },
    );
    throw error;
  }
}

export function isRunnerSqliteBusyError(error: unknown): boolean {
  const sqliteError = error as {
    errcode?: unknown;
  } | null;
  return typeof sqliteError?.errcode === "number"
    && (sqliteError.errcode & 0xff) === 5;
}

function readJournalMode(database: DatabaseSync): string {
  const row = database.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  return row.journal_mode.toLowerCase();
}

function observeTransaction(
  options: Pick<RunnerSqliteTransactionOptions, "transactionLabel" | "sessionId" | "observer">,
  transactionId: string,
  attempt: number,
  stage: RunnerSqliteTransactionStage,
  startedAtMonoMs: number,
  attemptStartedAtMonoMs: number,
  extra: Pick<RunnerSqliteTransactionEvent, "retryDelayMs" | "errorCode"> = {},
): void {
  if (!options.observer) return;
  const observedAtMonoMs = performance.now();
  try {
    options.observer({
      transactionId,
      transactionLabel: options.transactionLabel ?? "runner_sqlite.transaction",
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      attempt,
      stage,
      startedAtMonoMs,
      attemptStartedAtMonoMs,
      observedAtMonoMs,
      elapsedMs: observedAtMonoMs - startedAtMonoMs,
      attemptElapsedMs: observedAtMonoMs - attemptStartedAtMonoMs,
      ...(extra.retryDelayMs !== undefined ? { retryDelayMs: extra.retryDelayMs } : {}),
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
    });
  } catch (error) {
    if (transactionObserverFailureWarned) return;
    transactionObserverFailureWarned = true;
    process.emitWarning(`runner SQLite transaction observer failed: ${String(error)}`);
  }
}

function readErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; errcode?: unknown } | null;
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.errcode === "number") return String(candidate.errcode);
  return undefined;
}

async function sleepAsync(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
