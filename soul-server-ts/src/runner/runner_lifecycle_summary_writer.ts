import {
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  isTransientRenameError,
  renameWithTransientRetrySync,
  type SyncRenameRetryOptions,
} from "../atomic_file_rename.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

export interface RunnerSqliteLifecycleOptions extends SyncRenameRetryOptions {
  onSummaryRenameFailure?: (
    error: unknown,
    path: string,
    details: { consecutiveFailures: number; severity: "warn" | "error" },
  ) => void;
  onSummaryRenameRecovery?: (path: string, recoveredAfterFailures: number) => void;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  staleTmpMinAgeMs?: number;
  scavengeStaleTemps?: boolean;
}

export type RunnerLifecycleSummaryWriteResult =
  | { written: true }
  | { written: false; error: unknown };

export const RUNNER_LIFECYCLE_STALE_TMP_MIN_AGE_MS = 5 * 60_000;

const renameFailuresByPath = new Map<string, number>();

export class RunnerLifecycleSummaryWriter {
  constructor(
    private readonly path: string,
    private readonly options: RunnerSqliteLifecycleOptions,
  ) {
    if (options.scavengeStaleTemps !== false) {
      scavengeStaleLifecycleTemps(path, options);
    }
  }

  write(lifecycle: RunnerLifecycleRecord): void {
    const result = writeRunnerLifecycleSummary(this.path, lifecycle, this.options);
    if (result.written) {
      this.logRecoveryIfNeeded();
      return;
    }
    const consecutiveFailures = (renameFailuresByPath.get(this.path) ?? 0) + 1;
    renameFailuresByPath.set(this.path, consecutiveFailures);
    const severity = consecutiveFailures >= 3 ? "error" : "warn";
    const details = {
      consecutiveFailures,
      severity,
    } as const;
    if (this.options.onSummaryRenameFailure) {
      this.options.onSummaryRenameFailure(result.error, this.path, details);
      return;
    }
    const code = (result.error as NodeJS.ErrnoException).code ?? "unknown";
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    process.emitWarning(
      `Runner lifecycle summary rename retries exhausted `
      + `(${code}: ${message}; consecutive=${details.consecutiveFailures}; severity=${severity}): `
      + this.path,
      { code: severity === "error"
        ? "RUNNER_LIFECYCLE_SUMMARY_RENAME_PERSISTENT"
        : "RUNNER_LIFECYCLE_SUMMARY_RENAME_FAILED" },
    );
  }

  private logRecoveryIfNeeded(): void {
    const recoveredAfterFailures = renameFailuresByPath.get(this.path) ?? 0;
    if (recoveredAfterFailures === 0) return;
    renameFailuresByPath.delete(this.path);
    if (this.options.onSummaryRenameRecovery) {
      this.options.onSummaryRenameRecovery(this.path, recoveredAfterFailures);
      return;
    }
    process.emitWarning(
      `Runner lifecycle summary rename recovered after ${recoveredAfterFailures} failures: `
      + this.path,
      { code: "RUNNER_LIFECYCLE_SUMMARY_RENAME_RECOVERED" },
    );
  }
}

function scavengeStaleLifecycleTemps(
  path: string,
  options: RunnerSqliteLifecycleOptions,
): void {
  const directory = dirname(path);
  const prefix = `${basename(path)}.tmp-`;
  const now = (options.now ?? Date.now)();
  const minAgeMs = options.staleTmpMinAgeMs ?? RUNNER_LIFECYCLE_STALE_TMP_MIN_AGE_MS;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pidText = entry.slice(prefix.length);
    if (!/^\d+$/.test(pidText)) continue;
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const temporaryPath = join(directory, entry);
    try {
      if (now - statSync(temporaryPath).mtimeMs < minAgeMs || isPidAlive(pid)) continue;
      unlinkSync(temporaryPath);
    } catch {
      // Stale cache cleanup is best effort and never supersedes SQLite state.
    }
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeRunnerLifecycleSummary(
  path: string,
  lifecycle: RunnerLifecycleRecord,
  options: SyncRenameRetryOptions,
): RunnerLifecycleSummaryWriteResult {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(lifecycle)}\n`, { mode: 0o600 });
  try {
    renameWithTransientRetrySync(temporaryPath, path, options);
    return { written: true };
  } catch (error) {
    if (!isTransientRenameError(error)) throw error;
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The lifecycle sidecar is a cache. Cleanup cannot supersede the durable write outcome.
    }
    return { written: false, error };
  }
}
