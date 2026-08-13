import type {
  RunnerRecoveryDisposition,
  RunnerRegistration,
} from "./runner_process_registry.js";

export const RUNNER_RECOVERY_FAILURE_REEMIT_INTERVAL_MS = 15 * 60 * 1_000;

interface RecoveryFailureLogState {
  fingerprint: string;
  lastEmittedAtMs: number;
  suppressedSinceMs: number | null;
  suppressedCount: number;
}

export interface RecoveryFailureLogContext {
  suppressedSince?: string;
  suppressedCount?: number;
}

export class RunnerRecoveryFailureLogTracker {
  private readonly states = new Map<string, RecoveryFailureLogState>();

  constructor(
    private readonly reemitIntervalMs = RUNNER_RECOVERY_FAILURE_REEMIT_INTERVAL_MS,
  ) {
    if (!Number.isSafeInteger(reemitIntervalMs) || reemitIntervalMs <= 0) {
      throw new Error("runner recovery failure re-emit interval must be positive");
    }
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }

  prune(registrations: RunnerRegistration[]): void {
    const currentSessionIds = new Set(
      registrations.map((registration) => registration.config.sessionId),
    );
    for (const sessionId of this.states.keys()) {
      if (!currentSessionIds.has(sessionId)) this.states.delete(sessionId);
    }
  }

  record(sessionId: string, fingerprint: string, nowMs: number): RecoveryFailureLogContext | null {
    const current = this.states.get(sessionId);
    if (!current || current.fingerprint !== fingerprint) {
      this.states.set(sessionId, {
        fingerprint,
        lastEmittedAtMs: nowMs,
        suppressedSinceMs: null,
        suppressedCount: 0,
      });
      return {};
    }
    if (nowMs - current.lastEmittedAtMs < this.reemitIntervalMs) {
      current.suppressedSinceMs ??= nowMs;
      current.suppressedCount += 1;
      return null;
    }
    const context = current.suppressedSinceMs === null
      ? {}
      : {
          suppressedSince: new Date(current.suppressedSinceMs).toISOString(),
          suppressedCount: current.suppressedCount,
        };
    this.states.set(sessionId, {
      fingerprint,
      lastEmittedAtMs: nowMs,
      suppressedSinceMs: null,
      suppressedCount: 0,
    });
    return context;
  }
}

export function unreadableRegistrationFingerprint(failure: {
  error: Error;
  sessionId?: string;
  codeSha?: string;
}): string {
  const error = failure.error as Error & {
    code?: unknown;
    runnerRegistrationStage?: unknown;
  };
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    stage: error.runnerRegistrationStage ?? null,
    sessionId: failure.sessionId ?? null,
    codeSha: failure.codeSha ?? null,
  });
}

export function recoveryFailureFingerprint(
  registration: RunnerRegistration,
  disposition: RunnerRecoveryDisposition,
  failure: unknown,
): string {
  const error = failure instanceof Error ? failure : new Error(String(failure));
  const errorWithCode = error as Error & { code?: unknown };
  const code = errorWithCode.code;
  return JSON.stringify({
    disposition,
    name: error.name,
    message: error.message,
    code: code == null ? null : String(code),
    sessionId: registration.config.sessionId,
    codeSha: registration.config.codeSha,
    registrationId: registration.registrationId ?? null,
    pid: registration.pid,
    pidStartIdentity: registration.pidStartIdentity ?? null,
    pidAlive: registration.pidAlive,
    lifecycleState: registration.lifecycle?.execution_state ?? null,
    lifecycleProgressSeq: registration.lifecycle?.progress_seq ?? null,
    lifecycleProgressAt: registration.lifecycle?.progress_at ?? null,
  });
}
