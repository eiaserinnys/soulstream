// The sweep keeps its retention decisions and lock-to-trash ordering together;
// splitting the transaction across modules would obscure the deletion boundary.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { basename, dirname, join, resolve } from "node:path";
import type { Logger } from "pino";

import { renameWithTransientRetry } from "@soulstream/atomic-file-rename";
import {
  inspectRunnerDurableState,
  probeRunnerDurableRetention,
  readRunnerRegistrationForDeletion,
  type RunnerDurableRetentionProbe,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "./runner_process_registry.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";
import type { RunnerSessionMutationLockObservationContext } from "./runner_session_mutation_lock.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";
import type { RunnerRecoveryStorage } from "./runner_recovery_storage.js";
import {
  assertOwnedSessionDirectory,
  countRetainedReasons,
  hasCentralDeletionOverride,
  hasProvenEmptyPrebootstrapEvidence,
  isDeletedCentralSessionEvidence,
  isRetiredWithoutLifecycleAndNotAlive,
  sameRegistrationGeneration,
  terminalCandidateReason,
} from "./runner_session_gc_predicates.js";

export interface RunnerSessionGarbageCollectorDependencies {
  now(): number;
  monotonicNow(): number;
  withMutationLock<T>(
    sessionDirectory: string,
    operation: () => Promise<T>,
    observationContext?: RunnerSessionMutationLockObservationContext,
  ): Promise<T>;
  refresh(
    registration: RunnerRegistration,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerRegistration>;
  inspect(
    registration: RunnerRegistration,
    phaseObservation?: RunnerPhaseObservation,
  ): ReturnType<typeof inspectRunnerDurableState>;
  probeRetention(
    registration: RunnerRegistration,
    phaseObservation?: RunnerPhaseObservation,
  ): Promise<RunnerDurableRetentionProbe>;
  removeDirectory(path: string): Promise<void>;
  moveDirectory(source: string, destination: string): Promise<void>;
  listTrash(path: string): Promise<string[]>;
}

interface RunnerSessionGcDiagnostics {
  retentionProbeDecisions: Record<string, number>;
  durableInspectionCount: number;
  mutationLockCallbackEntries: number;
}

export interface RunnerSessionGcResult {
  removed: string[];
  retained: Array<{ sessionId: string; reason: string }>;
}

export interface RunnerSessionGarbageCollectionPolicy {
  listExistingSessionIds(sessionIds: string[]): Promise<string[]>;
}

export class RunnerSessionGarbageCollector {
  private readonly deps: RunnerSessionGarbageCollectorDependencies;

  constructor(
    private readonly stateDirectory: string,
    private readonly retentionMs: number,
    private readonly logger: Pick<Logger, "info" | "warn">,
    deps?: RunnerSessionGarbageCollectorDependencies,
    recoveryStorage?: RunnerRecoveryStorage,
  ) {
    if (!stateDirectory) throw new Error("runner state directory required for session GC");
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error("runner terminal retention must be positive");
    }
    this.deps = deps ?? defaultDependencies(recoveryStorage);
  }

  async collect(
    scan: RunnerRegistrationScan,
    policy?: RunnerSessionGarbageCollectionPolicy,
    phaseObservation?: RunnerPhaseObservation,
    runRemoval?: (operation: () => Promise<void>) => Promise<void>,
  ): Promise<RunnerSessionGcResult> {
    const startedAtMonotonicMs = this.deps.monotonicNow();
    const startedAtMs = this.deps.now();
    let measuredDurationMs: number | undefined;
    const durationMs = () => {
      measuredDurationMs ??= Math.max(
        0,
        this.deps.monotonicNow() - startedAtMonotonicMs,
      );
      return measuredDurationMs;
    };
    const diagnostics: RunnerSessionGcDiagnostics = {
      retentionProbeDecisions: {},
      durableInspectionCount: 0,
      mutationLockCallbackEntries: 0,
    };
    try {
      return await this.collectSweep(
        scan,
        startedAtMs,
        durationMs,
        diagnostics,
        policy,
        phaseObservation,
        runRemoval,
      );
    } catch (error) {
      const elapsedMs = durationMs();
      const failure = phaseObservation?.failureFor(error);
      try {
        this.logger.warn({
          err: error,
          startedAtMs,
          durationMs: elapsedMs,
          ...(failure ? { failurePhase: failure.phase, failureElapsedMs: failure.elapsedMs } : {}),
          ...(phaseObservation ? {
            phaseDurationsMs: phaseDurationsWithOtherMs(phaseObservation, elapsedMs),
            database: phaseObservation.databaseSummary(),
            databaseAndPhaseDurationsOverlap: true,
            nestedMutationTimingOverlapsAcquire: true,
          } : {}),
          ...diagnostics,
        }, "runner session GC sweep failed");
      } catch {
        // Preserve the original collection failure if reporting also fails.
      }
      throw error;
    }
  }

  private async collectSweep(
    scan: RunnerRegistrationScan,
    startedAtMs: number,
    durationMs: () => number,
    diagnostics: RunnerSessionGcDiagnostics,
    policy?: RunnerSessionGarbageCollectionPolicy,
    phaseObservation?: RunnerPhaseObservation,
    runRemoval?: (operation: () => Promise<void>) => Promise<void>,
  ): Promise<RunnerSessionGcResult> {
    const result: RunnerSessionGcResult = { removed: [], retained: [] };
    let lastFailure: unknown;
    const initialIds = scan.registrations.filter((registration) =>
      !terminalCandidateReason(registration, startedAtMs, this.retentionMs)
      && hasCentralDeletionOverride(registration, policy),
    ).map((registration) => registration.config.sessionId);
    const queriedIds = new Set(initialIds);
    let existingIds = new Set<string>();
    let lookupFailure: unknown;
    if (policy && initialIds.length > 0) {
      try {
        const lookup = () => policy.listExistingSessionIds(initialIds);
        existingIds = new Set(phaseObservation
          ? await phaseObservation.runAsync("centralSessionLookup", { label: "initial" }, lookup)
          : await lookup());
      } catch (error) {
        lookupFailure = error;
      }
    }
    const initialEvidence = (registration: RunnerRegistration): boolean => {
      if (!hasCentralDeletionOverride(registration, policy)) return false;
      if (lookupFailure !== undefined) throw lookupFailure;
      if (!queriedIds.has(registration.config.sessionId)) throw new Error("central session was not included in GC lookup");
      return !existingIds.has(registration.config.sessionId);
    };
    for (const registration of scan.registrations) {
      const candidateReason = terminalCandidateReason(
        registration,
        this.deps.now(),
        this.retentionMs,
      );
      if (candidateReason) {
        result.retained.push({ sessionId: registration.config.sessionId, reason: candidateReason });
        continue;
      }
      const observationArgs: [] | [RunnerSessionMutationLockObservationContext] = phaseObservation
        ? [{ phaseObservation, sessionId: registration.config.sessionId }]
        : [];
      await this.deps.withMutationLock(
        registration.config.paths.sessionDirectory,
        async () => {
          diagnostics.mutationLockCallbackEntries += 1;
          try {
            if (lookupFailure !== undefined && queriedIds.has(registration.config.sessionId)) throw lookupFailure;
            assertOwnedSessionDirectory(
              this.stateDirectory,
              registration.config.paths.sessionDirectory,
            );
            const refresh = () => this.deps.refresh(registration, phaseObservation);
            const fresh = phaseObservation
              ? await phaseObservation.runAsync("freshRegistration", {
                sessionId: registration.config.sessionId,
              }, refresh)
              : await refresh();
            const freshReason = terminalCandidateReason(
              fresh,
              this.deps.now(),
              this.retentionMs,
            );
            if (freshReason) {
              result.retained.push({ sessionId: registration.config.sessionId, reason: freshReason });
              return;
            }
            const probe = () => this.deps.probeRetention(fresh, phaseObservation);
            const retentionProbe = phaseObservation
              ? await phaseObservation.runAsync("durableRetentionProbe", {
                sessionId: registration.config.sessionId,
              }, probe)
              : await probe();
            const probeReason = retentionProbe.localRetentionReason;
            const probeDecision = probeReason ?? "full_inspection_required";
            diagnostics.retentionProbeDecisions[probeDecision] =
              (diagnostics.retentionProbeDecisions[probeDecision] ?? 0) + 1;
            if (!sameRegistrationGeneration(fresh, retentionProbe.registration)) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "registration_changed",
              });
              return;
            }
            const probeTerminalReason = terminalCandidateReason(
              retentionProbe.registration,
              this.deps.now(),
              this.retentionMs,
            );
            if (probeTerminalReason) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: probeTerminalReason,
              });
              return;
            }
            let deletedSessionEvidence = false;
            if (probeReason) {
              if (!hasCentralDeletionOverride(retentionProbe.registration, policy)) {
                result.retained.push({
                  sessionId: registration.config.sessionId,
                  reason: probeReason,
                });
                return;
              }
              deletedSessionEvidence = initialEvidence(retentionProbe.registration);
              if (!deletedSessionEvidence) {
                result.retained.push({
                  sessionId: registration.config.sessionId,
                  reason: probeReason,
                });
                return;
              }
            }
            diagnostics.durableInspectionCount += 1;
            const inspect = () => this.deps.inspect(retentionProbe.registration, phaseObservation);
            const inspection = phaseObservation
              ? await phaseObservation.runAsync("durableInspection", {
                sessionId: registration.config.sessionId,
              }, inspect)
              : await inspect();
            const hydrated = inspection.registration;
            if (!sameRegistrationGeneration(retentionProbe.registration, hydrated)) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "registration_changed",
              });
              return;
            }
            const verifiedReason = terminalCandidateReason(
              hydrated,
              this.deps.now(),
              this.retentionMs,
            );
            if (verifiedReason) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: verifiedReason,
              });
              return;
            }
            if (!probeReason) {
              deletedSessionEvidence = initialEvidence(hydrated);
            }
            if (!deletedSessionEvidence) {
              const retiredWithoutLifecycle = isRetiredWithoutLifecycleAndNotAlive(hydrated);
              if (!hydrated.lifecycle && !retiredWithoutLifecycle) {
                result.retained.push({
                  sessionId: registration.config.sessionId,
                  reason: "incomplete_bootstrap",
                });
                return;
              }
              if (!hydrated.bootstrap || retiredWithoutLifecycle) {
                if (!hasProvenEmptyPrebootstrapEvidence(inspection)) {
                  result.retained.push({
                    sessionId: registration.config.sessionId,
                    reason: "incomplete_bootstrap",
                  });
                  return;
                }
              } else {
                if (
                  inspection.acknowledgedThrough === null
                  || inspection.latestDurableSourceSeq === null
                  || inspection.acknowledgedThrough !== inspection.latestDurableSourceSeq
                ) {
                  result.retained.push({
                    sessionId: registration.config.sessionId,
                    reason: "final_ack_pending",
                  });
                  return;
                }
                if (inspection.incompleteDurableWork) {
                  result.retained.push({
                    sessionId: registration.config.sessionId,
                    reason: "durable_replay_pending",
                  });
                  return;
                }
              }
            }
            const refreshLatest = () => this.deps.refresh(hydrated, phaseObservation);
            const latest = phaseObservation
              ? await phaseObservation.runAsync("freshRegistration", {
                sessionId: registration.config.sessionId,
              }, refreshLatest)
              : await refreshLatest();
            if (!sameRegistrationGeneration(hydrated, latest)) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "registration_changed",
              });
              return;
            }
            const latestReason = terminalCandidateReason(
              latest,
              this.deps.now(),
              this.retentionMs,
            );
            if (latestReason) {
              result.retained.push({ sessionId: registration.config.sessionId, reason: latestReason });
              return;
            }
            if (
              deletedSessionEvidence
              && !await isDeletedCentralSessionEvidence(
                latest,
                policy,
                phaseObservation,
              )
            ) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "central_session_present",
              });
              return;
            }
            const sessionDirectory = latest.config.paths.sessionDirectory;
            const trashDirectory = join(this.stateDirectory, "_gc-trash");
            const destination = join(trashDirectory, `${basename(sessionDirectory)}-${randomUUID()}`);
            const remove = async () => {
              try {
                await this.deps.moveDirectory(sessionDirectory, destination);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                this.logger.warn({ err: error, sessionId: latest.config.sessionId }, "runner session GC rename failed; removing in place");
                await this.deps.removeDirectory(sessionDirectory);
              }
            };
            const removeDirectory = () => runRemoval ? runRemoval(remove) : remove();
            if (phaseObservation) {
              await phaseObservation.runAsync("removeDirectory", {
                sessionId: latest.config.sessionId,
              }, removeDirectory);
            } else {
              await removeDirectory();
            }
            result.removed.push(latest.config.sessionId);
            const prebootstrap = hydrated.bootstrap === null;
            this.logger.info(
              {
                sessionId: latest.config.sessionId,
                reason: deletedSessionEvidence
                  ? "expired_deleted_session_evidence"
                  : prebootstrap
                  ? "expired_terminal_prebootstrap_without_durable_work"
                  : "expired_terminal_final_ack_complete",
                executionState: hydrated.lifecycle?.execution_state ?? "deleted",
                ...(prebootstrap ? {
                  durableRecordCount: inspection.durableRecordCount,
                  unacknowledgedIpcFrameCount: inspection.unacknowledgedIpcFrameCount,
                } : {}),
              },
              "removed expired terminal runner session state",
            );
          } catch (error) {
            lastFailure = error;
            result.retained.push({
              sessionId: registration.config.sessionId,
              reason: "evidence_unreadable",
            });
            this.logger.warn(
              { err: error, sessionId: registration.config.sessionId },
              "runner session GC retained unreadable session evidence",
            );
          }
        },
        ...observationArgs,
      );
    }
    const trashStarted = this.deps.monotonicNow();
    const trashDirectory = resolve(this.stateDirectory, "_gc-trash");
    let trashRemoved = 0;
    try {
      const children = await this.deps.listTrash(trashDirectory);
      for (const child of children) {
        const path = resolve(trashDirectory, child);
        if (dirname(path) !== trashDirectory) {
          this.logger.warn({ path }, "runner session GC skipped invalid trash child");
          continue;
        }
        try {
          await this.deps.removeDirectory(path);
          trashRemoved += 1;
        } catch (error) {
          this.logger.warn({ err: error, path }, "runner session GC could not remove trash child");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn({ err: error, path: trashDirectory }, "runner session GC could not read trash");
      }
    }
    const trashDurationMs = Math.max(0, this.deps.monotonicNow() - trashStarted);
    const elapsedMs = durationMs();
    const phaseDurationsMs = phaseObservation
      ? phaseDurationsWithOtherMs(phaseObservation, elapsedMs)
      : undefined;
    this.logger.info(
      {
        inspected: scan.registrations.length,
        deleted: result.removed.length,
        deletedSessionIds: result.removed,
        retained: result.retained.length,
        retainedByReason: countRetainedReasons(result.retained),
        retainedSessions: result.retained,
        unreadableRegistrations: scan.errors.length,
        startedAtMs,
        durationMs: elapsedMs,
        trashRemoved,
        trashDurationMs,
        ...diagnostics,
        ...(phaseObservation ? {
          phaseDurationsMs,
          database: phaseObservation.databaseSummary(),
          databaseAndPhaseDurationsOverlap: true,
          nestedMutationTimingOverlapsAcquire: true,
          ...(lastFailure !== undefined
            && phaseObservation.failureFor(lastFailure)
            ? {
              failurePhase: phaseObservation.failureFor(lastFailure)!.phase,
              failureElapsedMs: phaseObservation.failureFor(lastFailure)!.elapsedMs,
            }
            : {}),
        } : {}),
      },
      "runner session GC sweep completed",
    );
    return result;
  }
}

function phaseDurationsWithOtherMs(
  phaseObservation: RunnerPhaseObservation,
  durationMs: number,
): Record<string, number> {
  const phaseDurationsMs = { ...phaseObservation.phaseDurationsMs() };
  const disjointPhases = [
    "mutationQueueWait",
    "mutationAcquire",
    "mutationRelease",
    "freshRegistration",
    "durableRetentionProbe",
    "durableInspection",
    "centralSessionLookup",
    "removeDirectory",
  ];
  const measuredMs = disjointPhases.reduce(
    (total, phase) => total + (phaseDurationsMs[phase] ?? 0),
    0,
  );
  phaseDurationsMs.otherMs = Math.max(0, durationMs - measuredMs);
  return phaseDurationsMs;
}

function defaultDependencies(
  recoveryStorage?: RunnerRecoveryStorage,
): RunnerSessionGarbageCollectorDependencies {
  return {
    now: Date.now,
    monotonicNow: () => performance.now(),
    withMutationLock: withRunnerSessionMutationLock,
    refresh: async (registration, phaseObservation) => await readRunnerRegistrationForDeletion(
      registration.config.paths.sessionDirectory,
      phaseObservation,
      recoveryStorage,
    ),
    inspect: async (registration, phaseObservation) => await inspectRunnerDurableState(
      registration,
      phaseObservation,
      recoveryStorage,
    ),
    probeRetention: async (registration, phaseObservation) => await probeRunnerDurableRetention(
      registration,
      phaseObservation,
      recoveryStorage,
    ),
    removeDirectory: async (path) => await rm(path, { recursive: true, force: true }),
    moveDirectory: async (source, destination) => {
      await mkdir(dirname(destination), { recursive: true });
      await renameWithTransientRetry(source, destination);
    },
    listTrash: async (path) => await readdir(path),
  };
}
