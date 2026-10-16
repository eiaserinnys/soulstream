import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Logger } from "pino";

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
import {
  assertOwnedSessionDirectory,
  countRetainedReasons,
  hasCentralDeletionOverride,
  hasProvenEmptyPrebootstrapEvidence,
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
  centralSessionExists(sessionId: string): Promise<boolean>;
}

export class RunnerSessionGarbageCollector {
  constructor(
    private readonly stateDirectory: string,
    private readonly retentionMs: number,
    private readonly logger: Pick<Logger, "info" | "warn">,
    private readonly deps: RunnerSessionGarbageCollectorDependencies = defaultDependencies(),
  ) {
    if (!stateDirectory) throw new Error("runner state directory required for session GC");
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error("runner terminal retention must be positive");
    }
  }

  async collect(
    scan: RunnerRegistrationScan,
    policy?: RunnerSessionGarbageCollectionPolicy,
    phaseObservation?: RunnerPhaseObservation,
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
  ): Promise<RunnerSessionGcResult> {
    const result: RunnerSessionGcResult = { removed: [], retained: [] };
    let lastFailure: unknown;
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
              deletedSessionEvidence = await isDeletedCentralSessionEvidence(
                retentionProbe.registration,
                policy,
                phaseObservation,
                "initial",
              );
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
              deletedSessionEvidence = await isDeletedCentralSessionEvidence(
                hydrated,
                policy,
                phaseObservation,
                "initial",
              );
            }
            if (!deletedSessionEvidence) {
              if (!hydrated.lifecycle) {
                result.retained.push({
                  sessionId: registration.config.sessionId,
                  reason: "incomplete_bootstrap",
                });
                return;
              }
              if (!hydrated.bootstrap) {
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
                "beforeDelete",
              )
            ) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "central_session_present",
              });
              return;
            }
            const removeDirectory = () => this.deps.removeDirectory(
              latest.config.paths.sessionDirectory,
            );
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
                  pendingInterventionCount: inspection.pendingInterventionCount,
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

async function isDeletedCentralSessionEvidence(
  registration: RunnerRegistration,
  policy: RunnerSessionGarbageCollectionPolicy | undefined,
  phaseObservation?: RunnerPhaseObservation,
  label: "initial" | "beforeDelete" = "initial",
): Promise<boolean> {
  if (!policy || !registration.retiredAt || registration.pidAlive) return false;
  const lookup = () => policy.centralSessionExists(registration.config.sessionId);
  const exists = phaseObservation
    ? await phaseObservation.runAsync("centralSessionLookup", {
      sessionId: registration.config.sessionId,
      label,
    }, lookup)
    : await lookup();
  return !exists;
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

function defaultDependencies(): RunnerSessionGarbageCollectorDependencies {
  return {
    now: Date.now,
    monotonicNow: () => performance.now(),
    withMutationLock: withRunnerSessionMutationLock,
    refresh: async (registration, phaseObservation) => await readRunnerRegistrationForDeletion(
      registration.config.paths.sessionDirectory,
      phaseObservation,
    ),
    inspect: inspectRunnerDurableState,
    probeRetention: probeRunnerDurableRetention,
    removeDirectory: async (path) => await rm(path, { recursive: true }),
  };
}
