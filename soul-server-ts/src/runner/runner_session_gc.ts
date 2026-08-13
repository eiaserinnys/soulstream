import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger } from "pino";

import {
  inspectRunnerDurableState,
  readRunnerRegistrationForDeletion,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "./runner_process_registry.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";

export interface RunnerSessionGarbageCollectorDependencies {
  now(): number;
  refresh(registration: RunnerRegistration): Promise<RunnerRegistration>;
  inspect(registration: RunnerRegistration): ReturnType<typeof inspectRunnerDurableState>;
  removeDirectory(path: string): Promise<void>;
}

export interface RunnerSessionGcResult {
  removed: string[];
  retained: Array<{ sessionId: string; reason: string }>;
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

  async collect(scan: RunnerRegistrationScan): Promise<RunnerSessionGcResult> {
    const result: RunnerSessionGcResult = { removed: [], retained: [] };
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
      await withRunnerSessionMutationLock(
        registration.config.paths.sessionDirectory,
        async () => {
          try {
            assertOwnedSessionDirectory(
              this.stateDirectory,
              registration.config.paths.sessionDirectory,
            );
            const fresh = await this.deps.refresh(registration);
            const freshReason = terminalCandidateReason(
              fresh,
              this.deps.now(),
              this.retentionMs,
            );
            if (freshReason) {
              result.retained.push({ sessionId: registration.config.sessionId, reason: freshReason });
              return;
            }
            const inspection = await this.deps.inspect(fresh);
            const hydrated = inspection.registration;
            if (!sameRegistrationGeneration(fresh, hydrated)) {
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
            const latest = await this.deps.refresh(hydrated);
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
            await this.deps.removeDirectory(latest.config.paths.sessionDirectory);
            result.removed.push(latest.config.sessionId);
            const prebootstrap = hydrated.bootstrap === null;
            this.logger.info(
              {
                sessionId: latest.config.sessionId,
                reason: prebootstrap
                  ? "expired_terminal_prebootstrap_without_durable_work"
                  : "expired_terminal_final_ack_complete",
                executionState: hydrated.lifecycle.execution_state,
                ...(prebootstrap ? {
                  durableRecordCount: inspection.durableRecordCount,
                  unacknowledgedIpcFrameCount: inspection.unacknowledgedIpcFrameCount,
                  pendingInterventionCount: inspection.pendingInterventionCount,
                } : {}),
              },
              "removed expired terminal runner session state",
            );
          } catch (error) {
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
      );
    }
    this.logger.info(
      {
        inspected: scan.registrations.length,
        deleted: result.removed.length,
        deletedSessionIds: result.removed,
        retained: result.retained.length,
        retainedByReason: countRetainedReasons(result.retained),
        retainedSessions: result.retained,
        unreadableRegistrations: scan.errors.length,
      },
      "runner session GC sweep completed",
    );
    return result;
  }
}

function hasProvenEmptyPrebootstrapEvidence(
  inspection: Awaited<ReturnType<typeof inspectRunnerDurableState>>,
): boolean {
  return inspection.durableRecordCount === 0
    && inspection.unacknowledgedIpcFrameCount === 0
    && inspection.pendingInterventionCount === 0;
}

function terminalCandidateReason(
  registration: RunnerRegistration,
  nowMs: number,
  retentionMs: number,
): string | null {
  if (registration.pid === null) return "pid_evidence_missing";
  if (registration.pidAlive) return "live_runner";
  const lifecycle = registration.lifecycle;
  if (!lifecycle) return "lifecycle_missing";
  if (lifecycle.execution_state === "running") return "running_lifecycle";
  const terminalAt = Date.parse(lifecycle.progress_at);
  if (!Number.isFinite(terminalAt)) return "terminal_timestamp_invalid";
  if (nowMs - terminalAt < retentionMs) return "retention_window";
  return null;
}

function countRetainedReasons(
  retained: RunnerSessionGcResult["retained"],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of retained) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}

function assertOwnedSessionDirectory(stateDirectory: string, sessionDirectory: string): void {
  const state = resolve(stateDirectory);
  const session = resolve(sessionDirectory);
  if (session === state || resolve(dirname(session)) !== state) {
    throw new Error(`runner session directory escaped state root: ${sessionDirectory}`);
  }
}

function defaultDependencies(): RunnerSessionGarbageCollectorDependencies {
  return {
    now: Date.now,
    refresh: async (registration) => await readRunnerRegistrationForDeletion(
      registration.config.paths.sessionDirectory,
    ),
    inspect: inspectRunnerDurableState,
    removeDirectory: async (path) => await rm(path, { recursive: true }),
  };
}

function sameRegistrationGeneration(
  left: RunnerRegistration,
  right: RunnerRegistration,
): boolean {
  return left.config.sessionId === right.config.sessionId
    && left.config.codeSha === right.config.codeSha
    && left.config.paths.sessionDirectory === right.config.paths.sessionDirectory
    && (left.registrationId ?? null) === (right.registrationId ?? null)
    && left.pid === right.pid
    && (left.pidStartIdentity ?? null) === (right.pidStartIdentity ?? null);
}
