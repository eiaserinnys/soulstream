import type { Logger } from "pino";

import {
  scanRunnerRegistrations,
  type RunnerRegistration,
} from "./runner_process_registry.js";
import { RunnerReleasePool } from "./runner_release_pool.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";

export interface RunnerReleaseGarbageCollectorDependencies {
  scan(stateDirectory: string): ReturnType<typeof scanRunnerRegistrations>;
  hasIncompleteDurableWork(registration: RunnerRegistration): Promise<boolean>;
}

export interface RunnerReleaseGcResult {
  removed: string[];
  retained: Array<{ releaseId: string; reason: string }>;
}

/**
 * Deletes only releases with positive proof that every referencing session is
 * stopped, terminal, and fully ACKed. Missing/unreadable evidence retains data.
 */
export class RunnerReleaseGarbageCollector {
  constructor(
    private readonly pool: RunnerReleasePool,
    private readonly stateDirectory: string,
    private readonly logger: Pick<Logger, "info">,
    private readonly deps: RunnerReleaseGarbageCollectorDependencies = defaultDependencies(),
  ) {
    if (!stateDirectory) throw new Error("runner state directory required for release GC");
  }

  async collect(): Promise<RunnerReleaseGcResult> {
    const result: RunnerReleaseGcResult = { removed: [], retained: [] };
    for (const release of await this.pool.listReadyReleases()) {
      await this.pool.withReleaseLock(release.releaseId, async () => {
        // Re-scan under the same per-release lock used by materialization. A
        // spawn that registered SQLite/config before ensure therefore becomes
        // visible before GC can remove the newly ensured release.
        const scan = await this.deps.scan(this.stateDirectory);
        if (scan.errors.length > 0) {
          throw new AggregateError(
            scan.errors.map((failure) => failure.error),
            "runner release GC refused an incomplete registration inventory",
          );
        }
        const registrations = scan.registrations.filter(
          (registration) => registration.config.codeSha === release.releaseId,
        );
        if (registrations.length === 0) {
          result.retained.push({ releaseId: release.releaseId, reason: "no_final_ack_evidence" });
          return;
        }
        for (const registration of registrations) {
          const reason = await referenceReason(registration, this.deps);
          if (reason) {
            result.retained.push({ releaseId: release.releaseId, reason });
            return;
          }
        }
        await this.pool.removeReleaseLocked(release);
        result.removed.push(release.releaseId);
        this.logger.info({ releaseId: release.releaseId }, "removed unreferenced runner release");
      });
    }
    return result;
  }
}

async function referenceReason(
  registration: RunnerRegistration,
  deps: RunnerReleaseGarbageCollectorDependencies,
): Promise<string | null> {
  // PID liveness is deliberately stronger than a progress lease for deletion:
  // reaper must terminate a stale process before its executable tree can go.
  if (registration.pidAlive) return "live_runner";
  if (!registration.bootstrap || !registration.lifecycle) return "incomplete_bootstrap";
  if (registration.lifecycle.execution_state === "running") return "running_lifecycle";
  if (await deps.hasIncompleteDurableWork(registration)) return "final_ack_pending";
  return null;
}

function defaultDependencies(): RunnerReleaseGarbageCollectorDependencies {
  return {
    scan: scanRunnerRegistrations,
    hasIncompleteDurableWork: async (registration) => {
      const outbox = await RunnerSqliteEventOutbox.open(registration.config.paths.databasePath);
      try {
        return await outbox.hasPendingDurableWork();
      } finally {
        outbox.close();
      }
    },
  };
}
