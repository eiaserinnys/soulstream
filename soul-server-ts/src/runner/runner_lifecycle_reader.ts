import { unlink } from "node:fs/promises";

import {
  readRunnerLifecycleSummary,
  readRunnerSqliteLifecycle,
  runnerLifecycleSummaryPath,
  type RunnerLifecycleRecord,
  type RunnerSqliteLifecycleOptions,
} from "./sqlite_runner_lifecycle.js";
import type {
  RunnerPhaseExecutor,
  RunnerPhaseObservation,
} from "./runner_phase_observation.js";
import { RunnerLifecycleSummaryWriter } from "./runner_lifecycle_summary_writer.js";
import {
  withRunnerRecoveryStorage,
  type RunnerRecoveryStorage,
} from "./runner_recovery_storage.js";

export interface AuthoritativeRunnerLifecycleOptions {
  recoveryStorage?: RunnerRecoveryStorage;
  phaseObservation?: RunnerPhaseObservation;
  sessionId?: string;
}

export interface AuthoritativeRunnerLifecycleLocalOptions {
  lifecycleSummaryOptions?: RunnerSqliteLifecycleOptions;
  phaseObservation?: RunnerPhaseExecutor;
  sessionId?: string;
}

/**
 * Reads recovery state through the storage worker. The worker reads SQLite and
 * repairs the JSON sidecar cache inside one request.
 */
export async function readAuthoritativeRunnerLifecycle(
  databasePath: string,
  options: AuthoritativeRunnerLifecycleOptions = {},
): Promise<RunnerLifecycleRecord | null> {
  return await withRunnerRecoveryStorage(options.recoveryStorage, async (storage) =>
    await storage.readAuthoritativeLifecycle(
      {
        databasePath,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      },
      options.phaseObservation,
    ));
}

/**
 * Worker-only body: reads recovery state from SQLite and treats the JSON
 * sidecar as a repairable cache only. Cache repair gets one immediate rename
 * attempt; a periodic scan must never block the event loop on an inline retry
 * schedule.
 */
export async function readAuthoritativeRunnerLifecycleLocal(
  databasePath: string,
  options: AuthoritativeRunnerLifecycleLocalOptions = {},
): Promise<RunnerLifecycleRecord | null> {
  let cachedLifecycle: RunnerLifecycleRecord | null = null;
  let cacheNeedsRefresh = false;
  try {
    cachedLifecycle = await readRunnerLifecycleSummary(databasePath);
  } catch {
    cacheNeedsRefresh = true;
  }
  const summaryWriter = new RunnerLifecycleSummaryWriter(
    runnerLifecycleSummaryPath(databasePath),
    {
      ...options.lifecycleSummaryOptions,
      retryDelaysMs: [],
      scavengeStaleTemps: false,
    },
  );
  const durableLifecycle = readRunnerSqliteLifecycle(
    databasePath,
    options.phaseObservation
      ? {
        phaseObservation: options.phaseObservation,
        ...(options.sessionId
          ? { sessionId: options.sessionId }
          : cachedLifecycle?.session_id
            ? { sessionId: cachedLifecycle.session_id }
            : {}),
        label: "authoritative lifecycle",
      }
      : undefined,
  );
  if (
    cacheNeedsRefresh
    || JSON.stringify(cachedLifecycle) !== JSON.stringify(durableLifecycle)
  ) {
    if (durableLifecycle) {
      summaryWriter.write(durableLifecycle);
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
}

function emitLifecycleCacheRefreshWarning(databasePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(
    `Runner lifecycle cache refresh failed; durable SQLite state retained (${message}): `
    + runnerLifecycleSummaryPath(databasePath),
    { code: "RUNNER_LIFECYCLE_SUMMARY_REFRESH_FAILED" },
  );
}
