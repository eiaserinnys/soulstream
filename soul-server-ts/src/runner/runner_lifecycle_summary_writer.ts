import { writeFileSync } from "node:fs";

import {
  isTransientRenameError,
  renameWithTransientRetrySync,
  type SyncRenameRetryOptions,
} from "../atomic_file_rename.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

export interface RunnerSqliteLifecycleOptions extends SyncRenameRetryOptions {
  onSummaryRenameFailure?: (error: unknown, path: string) => void;
}

export function writeRunnerLifecycleSummary(
  path: string,
  lifecycle: RunnerLifecycleRecord,
  options: RunnerSqliteLifecycleOptions,
): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(lifecycle)}\n`, { mode: 0o600 });
  try {
    renameWithTransientRetrySync(temporaryPath, path, options);
  } catch (error) {
    if (!isTransientRenameError(error)) throw error;
    if (options.onSummaryRenameFailure) {
      options.onSummaryRenameFailure(error, path);
      return;
    }
    const code = (error as NodeJS.ErrnoException).code ?? "unknown";
    const message = error instanceof Error ? error.message : String(error);
    process.emitWarning(
      `Runner lifecycle summary rename retries exhausted (${code}: ${message}): ${path}`,
      { code: "RUNNER_LIFECYCLE_SUMMARY_RENAME_FAILED" },
    );
  }
}
