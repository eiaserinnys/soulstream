import type { DatabaseSync } from "node:sqlite";

import { loadNodeSqlite } from "./node_sqlite.js";

export const RUNNER_SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS = [50, 200] as const;

export interface RunnerSqliteOpenOptions {
  readOnly?: boolean;
}

export interface RunnerSqliteBusyRetryOptions {
  sleep?: (delayMs: number) => void;
  retryDelaysMs?: readonly number[];
}

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

export function withRunnerSqliteBusyRetry<T>(
  operation: () => T,
  options: RunnerSqliteBusyRetryOptions = {},
): T {
  const retryDelaysMs = options.retryDelaysMs ?? RUNNER_SQLITE_BUSY_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepSync;
  let retryIndex = 0;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isRunnerSqliteBusyError(error) || retryIndex >= retryDelaysMs.length) {
        throw error;
      }
      sleep(retryDelaysMs[retryIndex]!);
      retryIndex += 1;
    }
  }
}

export function withRunnerSqliteTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: RunnerSqliteBusyRetryOptions = {},
): T {
  return withRunnerSqliteBusyRetry(() => {
    let transactionOpen = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const result = operation();
      database.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the initiating SQLite error; retry classification depends on it.
        }
      }
      throw error;
    }
  }, options);
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

function sleepSync(delayMs: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, delayMs);
}
