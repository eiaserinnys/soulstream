import type { Logger } from "pino";

import {
  inspectRunnerDurableState,
  scanRunnerRegistrations,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "./runner_process_registry.js";
import type { RunnerReleaseDescriptor } from "./runner_release_materializer.js";
import { RunnerReleasePool } from "./runner_release_pool.js";
import type { ProcessOwnershipDirectoryLock } from "./runner_process_lock.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";
import type { RunnerRecoveryStorage } from "./runner_recovery_storage.js";

export interface RunnerReleaseGarbageCollectorDependencies {
  scan(
    stateDirectory: string,
    phaseObservation?: RunnerPhaseObservation,
  ): ReturnType<typeof scanRunnerRegistrations>;
  inspect(
    registration: RunnerRegistration,
    phaseObservation?: RunnerPhaseObservation,
  ): ReturnType<typeof inspectRunnerDurableState>;
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
  private readonly deps: RunnerReleaseGarbageCollectorDependencies;

  constructor(
    private readonly pool: RunnerReleasePool,
    private readonly stateDirectory: string,
    private readonly logger: Pick<Logger, "info" | "warn">,
    deps?: RunnerReleaseGarbageCollectorDependencies,
    recoveryStorage?: RunnerRecoveryStorage,
    private readonly currentReleaseId?: string,
  ) {
    if (!stateDirectory) throw new Error("runner state directory required for release GC");
    this.deps = deps ?? defaultDependencies(recoveryStorage);
  }

  async collect(
    _existingScan?: RunnerRegistrationScan,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerReleaseGcResult> {
    const result: RunnerReleaseGcResult = { removed: [], retained: [] };
    let lastInspectionFailure: unknown;
    const report = (failed?: unknown): void => {
      const failureError = failed ?? lastInspectionFailure;
      const failure = failureError === undefined
        ? undefined
        : phaseObservation?.failureFor(failureError);
      const summary = {
        removed: result.removed.length,
        retained: result.retained.length,
        retainedByReason: countRetainedReleaseReasons(result.retained),
        ...(phaseObservation ? {
          phaseDurationsMs: phaseObservation.phaseDurationsMs(),
          database: phaseObservation.databaseSummary(),
          databaseAndPhaseDurationsOverlap: true,
        } : {}),
        ...(failure ? { failurePhase: failure.phase, failureElapsedMs: failure.elapsedMs } : {}),
      };
      if (failed === undefined) {
        try {
          this.logger.info(summary, "runner release GC sweep completed");
        } catch (error) {
          try {
            this.logger.warn({ err: error }, "runner phase observation failed");
          } catch {
            // Telemetry must not change release collection results.
          }
        }
      } else {
        try {
          this.logger.warn({ ...summary, err: failed }, "runner release GC sweep failed");
        } catch {
          // Preserve the original collection failure if reporting also fails.
        }
      }
    };
    try {
      const enumerate = () => this.pool.listReleaseCandidates();
      const releases = phaseObservation
        ? await phaseObservation.runAsync("enumerateAndVerify", {}, enumerate)
        : await enumerate();
      const candidates = releases.filter(
        (release) => release.releaseId !== this.currentReleaseId,
      );
      if (candidates.length > 0) {
        await this.collectFenced(candidates, result, phaseObservation, (failure) => {
          lastInspectionFailure = failure;
        });
      }
      report();
      return result;
    } catch (error) {
      report(error);
      throw error;
    }
  }

  /**
   * Fences the candidates it can take without waiting, then re-reads
   * registration evidence under those locks. A candidate whose lock is held
   * elsewhere is reported as `lock_held` and never blocks the sweep.
   */
  private async collectFenced(
    candidates: RunnerReleaseDescriptor[],
    result: RunnerReleaseGcResult,
    phaseObservation: RunnerPhaseObservation | undefined,
    recordInspectionFailure: (failure: unknown) => void,
  ): Promise<void> {
    const ordered = [...candidates].sort((left, right) =>
      left.releaseId.localeCompare(right.releaseId));
    const locked: Array<{ releaseId: string; lock: ProcessOwnershipDirectoryLock }> = [];
    try {
      for (const release of ordered) {
        const lock = await this.pool.tryReleaseLock(release.releaseId, phaseObservation);
        if (lock === null) {
          result.retained.push({ releaseId: release.releaseId, reason: "lock_held" });
          continue;
        }
        locked.push({ releaseId: release.releaseId, lock });
      }
      if (locked.length === 0) return;
      const lockedIds = new Set(locked.map((entry) => entry.releaseId));
      const fencedReleases = ordered.filter((release) => lockedIds.has(release.releaseId));
      // Registration and process ownership are re-read only after every
      // candidate release is fenced. The periodic scan is never deletion proof.
      const readRegistry = () => this.deps.scan(this.stateDirectory, phaseObservation);
      const scan = phaseObservation
        ? await phaseObservation.runAsync("registry", {}, readRegistry)
        : await readRegistry();
      const unknownFailures = scan.errors.filter((failure) => !failure.codeSha);
      if (unknownFailures.length > 0) {
        this.logger.warn(
          { failures: unknownFailures.map((failure) => failure.directory) },
          "runner release GC retained all releases because registration evidence is incomplete",
        );
        for (const release of fencedReleases) {
          result.retained.push({ releaseId: release.releaseId, reason: "inventory_incomplete" });
        }
        return;
      }
      releaseLoop: for (const release of fencedReleases) {
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
            const inspect = () => this.deps.inspect(registration, phaseObservation);
            inspection = phaseObservation
              ? await phaseObservation.runAsync("durableInspection", {
                sessionId: registration.config.sessionId,
              }, inspect)
              : await inspect();
          } catch (error) {
            recordInspectionFailure(error);
            result.retained.push({ releaseId: release.releaseId, reason: "evidence_unreadable" });
            this.logger.warn(
              { err: error, releaseId: release.releaseId, sessionId: registration.config.sessionId },
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
        try {
          const verify = () => this.pool.verifyReleaseLocked(release);
          if (phaseObservation) {
            await phaseObservation.runAsync(
              "candidateVerification",
              { label: release.releaseId },
              verify,
            );
          } else {
            await verify();
          }
        } catch (error) {
          recordInspectionFailure(error);
          result.retained.push({ releaseId: release.releaseId, reason: "evidence_unreadable" });
          this.logger.warn(
            { err: error, releaseId: release.releaseId },
            "runner release GC retained release because release verification failed",
          );
          continue releaseLoop;
        }
        await this.pool.removeReleaseLocked(release);
        result.removed.push(release.releaseId);
        this.logger.info({ releaseId: release.releaseId }, "removed unreferenced runner release");
      }
    } finally {
      let releaseFailure: unknown;
      for (const entry of [...locked].reverse()) {
        try {
          await entry.lock.release();
        } catch (error) {
          releaseFailure ??= error;
        }
      }
      if (releaseFailure !== undefined) throw releaseFailure;
    }
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

function defaultDependencies(
  recoveryStorage?: RunnerRecoveryStorage,
): RunnerReleaseGarbageCollectorDependencies {
  return {
    scan: async (stateDirectory, phaseObservation) => await scanRunnerRegistrations(
      stateDirectory,
      {
        verifyProcessIdentity: true,
        ...(phaseObservation ? { phaseObservation } : {}),
        ...(recoveryStorage ? { recoveryStorage } : {}),
      },
    ),
    inspect: async (registration, phaseObservation) => await inspectRunnerDurableState(
      registration,
      phaseObservation,
      recoveryStorage,
    ),
  };
}

function countRetainedReleaseReasons(
  retained: RunnerReleaseGcResult["retained"],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of retained) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}
