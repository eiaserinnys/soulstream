import type { Logger } from "pino";

import {
  inspectRunnerDurableState,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "./runner_process_registry.js";
import { RunnerReleasePool } from "./runner_release_pool.js";

export interface RunnerReleaseGarbageCollectorDependencies {
  scan(stateDirectory: string): ReturnType<typeof scanRunnerRegistrations>;
  inspect(registration: RunnerRegistration): ReturnType<typeof inspectRunnerDurableState>;
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
    private readonly logger: Pick<Logger, "info" | "warn">,
    private readonly deps: RunnerReleaseGarbageCollectorDependencies = defaultDependencies(),
  ) {
    if (!stateDirectory) throw new Error("runner state directory required for release GC");
  }

  async collect(_existingScan?: RunnerRegistrationScan): Promise<RunnerReleaseGcResult> {
    const result: RunnerReleaseGcResult = { removed: [], retained: [] };
    const releases = await this.pool.listReadyReleases();
    if (releases.length === 0) return result;
    return await this.pool.withReleaseLocks(
      releases.map((release) => release.releaseId),
      async () => {
        // Registration and process ownership are re-read only after every
        // candidate release is fenced. The periodic scan is never deletion proof.
        const scan = await this.deps.scan(this.stateDirectory);
        const unknownFailures = scan.errors.filter((failure) => !failure.codeSha);
        if (unknownFailures.length > 0) {
          this.logger.warn(
            { failures: unknownFailures.map((failure) => failure.directory) },
            "runner release GC retained all releases because registration evidence is incomplete",
          );
          for (const release of releases) {
            result.retained.push({ releaseId: release.releaseId, reason: "inventory_incomplete" });
          }
          return result;
        }
        releaseLoop: for (const release of releases) {
          if (scan.errors.some((failure) => failure.codeSha === release.releaseId)) {
            result.retained.push({ releaseId: release.releaseId, reason: "inventory_incomplete" });
            continue;
          }
          const registrations = scan.registrations.filter(
            (registration) => registration.config.codeSha === release.releaseId,
          );
          if (registrations.length === 0) {
            result.retained.push({ releaseId: release.releaseId, reason: "no_final_ack_evidence" });
            continue;
          }
          for (const registration of registrations) {
            const lightweightReason = lightweightReferenceReason(registration);
            if (lightweightReason) {
              result.retained.push({ releaseId: release.releaseId, reason: lightweightReason });
              if (lightweightReason === "pid_evidence_missing") {
                this.logger.warn(
                  { releaseId: release.releaseId, sessionId: registration.config.sessionId },
                  "runner release GC retained release because PID evidence is missing",
                );
              }
              continue releaseLoop;
            }
            let inspection: Awaited<ReturnType<typeof inspectRunnerDurableState>>;
            try {
              inspection = await this.deps.inspect(registration);
            } catch (error) {
              result.retained.push({ releaseId: release.releaseId, reason: "evidence_unreadable" });
              this.logger.warn(
                { error, releaseId: release.releaseId, sessionId: registration.config.sessionId },
                "runner release GC retained release because session evidence is unreadable",
              );
              continue releaseLoop;
            }
            const reason = referenceReason(
              inspection.registration,
              inspection.incompleteDurableWork,
            );
            if (reason) {
              result.retained.push({ releaseId: release.releaseId, reason });
              if (reason === "pid_evidence_missing") {
                this.logger.warn(
                  { releaseId: release.releaseId, sessionId: registration.config.sessionId },
                  "runner release GC retained release because PID evidence is missing",
                );
              }
              continue releaseLoop;
            }
          }
          await this.pool.removeReleaseLocked(release);
          result.removed.push(release.releaseId);
          this.logger.info({ releaseId: release.releaseId }, "removed unreferenced runner release");
        }
        return result;
      },
    );
  }
}

function referenceReason(
  registration: RunnerRegistration,
  incompleteDurableWork: boolean,
): string | null {
  // PID liveness is deliberately stronger than a progress lease for deletion:
  // reaper must terminate a stale process before its executable tree can go.
  if (registration.pid === null) return "pid_evidence_missing";
  if (registration.pidAlive) return "live_runner";
  if (!registration.registrationId || !registration.pidStartIdentity) {
    return "ownership_evidence_missing";
  }
  if (!registration.bootstrap || !registration.lifecycle) return "incomplete_bootstrap";
  if (registration.lifecycle.execution_state === "running") return "running_lifecycle";
  if (incompleteDurableWork) return "final_ack_pending";
  return null;
}

function lightweightReferenceReason(registration: RunnerRegistration): string | null {
  if (registration.pid === null) return "pid_evidence_missing";
  if (registration.pidAlive) return "live_runner";
  if (!registration.registrationId || !registration.pidStartIdentity) {
    return "ownership_evidence_missing";
  }
  if (!registration.lifecycle) return "lifecycle_missing";
  if (registration.lifecycle.execution_state === "running") return "running_lifecycle";
  return null;
}

function defaultDependencies(): RunnerReleaseGarbageCollectorDependencies {
  return {
    scan: async (stateDirectory) => await scanRunnerRegistrations(
      stateDirectory,
      { verifyProcessIdentity: true },
    ),
    inspect: inspectRunnerDurableState,
  };
}
