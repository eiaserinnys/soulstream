import { unlinkSync, writeFileSync } from "node:fs";

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
}

export type RunnerLifecycleSummaryWriteResult =
  | { written: true }
  | { written: false; error: unknown };

export class RunnerLifecycleSummaryWriter {
  private consecutiveRenameFailures = 0;

  constructor(
    private readonly path: string,
    private readonly options: RunnerSqliteLifecycleOptions,
  ) {}

  write(lifecycle: RunnerLifecycleRecord): void {
    const result = writeRunnerLifecycleSummary(this.path, lifecycle, this.options);
    if (result.written) {
      this.logRecoveryIfNeeded();
      return;
    }
    this.consecutiveRenameFailures += 1;
    const severity = this.consecutiveRenameFailures >= 3 ? "error" : "warn";
    const details = {
      consecutiveFailures: this.consecutiveRenameFailures,
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
    if (this.consecutiveRenameFailures === 0) return;
    const recoveredAfterFailures = this.consecutiveRenameFailures;
    this.consecutiveRenameFailures = 0;
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
