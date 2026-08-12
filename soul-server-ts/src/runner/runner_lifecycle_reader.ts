import { unlink } from "node:fs/promises";

import {
  readRunnerLifecycleSummary,
  runnerLifecycleSummaryPath,
  RunnerSqliteLifecycle,
  type RunnerLifecycleRecord,
  type RunnerSqliteLifecycleOptions,
} from "./sqlite_runner_lifecycle.js";

export interface AuthoritativeRunnerLifecycleOptions {
  lifecycleSummaryOptions?: RunnerSqliteLifecycleOptions;
}

/**
 * Reads recovery state from SQLite and treats the JSON sidecar as a repairable
 * cache only. Cache repair gets one immediate rename attempt; a periodic scan
 * must never block the event loop on an inline retry schedule.
 */
export async function readAuthoritativeRunnerLifecycle(
  databasePath: string,
  options: AuthoritativeRunnerLifecycleOptions = {},
): Promise<RunnerLifecycleRecord | null> {
  let cachedLifecycle: RunnerLifecycleRecord | null = null;
  let cacheNeedsRefresh = false;
  try {
    cachedLifecycle = await readRunnerLifecycleSummary(databasePath);
  } catch {
    cacheNeedsRefresh = true;
  }
  const lifecycleStore = RunnerSqliteLifecycle.open(databasePath, undefined, {
    ...options.lifecycleSummaryOptions,
    retryDelaysMs: [],
    scavengeStaleTemps: false,
  });
  try {
    const durableLifecycle = lifecycleStore.read();
    if (
      cacheNeedsRefresh
      || JSON.stringify(cachedLifecycle) !== JSON.stringify(durableLifecycle)
    ) {
      if (durableLifecycle) {
        lifecycleStore.syncSummary();
      } else {
        try {
          await unlink(runnerLifecycleSummaryPath(databasePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            emitLifecycleCacheRefreshWarning(databasePath, error);
          }
        }
      }
    }
    return durableLifecycle;
  } finally {
    lifecycleStore.close();
  }
}

function emitLifecycleCacheRefreshWarning(databasePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `Runner lifecycle cache refresh failed; durable SQLite state retained (${message}): `
    + runnerLifecycleSummaryPath(databasePath),
    { code: "RUNNER_LIFECYCLE_SUMMARY_REFRESH_FAILED" },
  );
}
