import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Logger } from "pino";

import {
  inspectRunnerDurableState,
  type RunnerRegistration,
  type RunnerRegistrationScan,
} from "./runner_process_registry.js";
import { withRunnerSessionMutationLock } from "./runner_session_mutation_lock.js";

export interface RunnerSessionGarbageCollectorDependencies {
  now(): number;
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
            const inspection = await this.deps.inspect(registration);
            const hydrated = inspection.registration;
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
            if (!hydrated.bootstrap || !hydrated.lifecycle) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "incomplete_bootstrap",
              });
              return;
            }
            if (inspection.incompleteDurableWork) {
              result.retained.push({
                sessionId: registration.config.sessionId,
                reason: "final_ack_pending",
              });
              return;
            }
            await this.deps.removeDirectory(hydrated.config.paths.sessionDirectory);
            result.removed.push(hydrated.config.sessionId);
            this.logger.info(
              { sessionId: hydrated.config.sessionId },
              "removed expired terminal runner session state",
            );
          } catch (error) {
            result.retained.push({
              sessionId: registration.config.sessionId,
              reason: "evidence_unreadable",
            });
            this.logger.warn(
              { error, sessionId: registration.config.sessionId },
              "runner session GC retained unreadable session evidence",
            );
          }
        },
      );
    }
    return result;
  }
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
    inspect: inspectRunnerDurableState,
    removeDirectory: async (path) => await rm(path, { recursive: true }),
  };
}
