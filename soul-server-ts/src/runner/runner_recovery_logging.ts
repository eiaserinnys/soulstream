import type { Logger } from "pino";

import {
  RunnerRecoveryFailureLogTracker,
  recoveryFailureFingerprint,
} from "./runner_recovery_fingerprint.js";
import type { RunnerRecoveryHydrationOutcome } from "./runner_recovery_hydration_phase.js";
import type {
  RunnerRecoveryDisposition,
  RunnerRegistration,
} from "./runner_process_registry.js";

export class RunnerRecoveryLogger {
  private readonly failures = new RunnerRecoveryFailureLogTracker();
  private readonly missingSessionReported = new Map<string, string | null>();

  constructor(private readonly options: {
    logger: Pick<Logger, "error" | "warn">;
    now: () => number;
  }) {}

  clear(sessionId: string): void {
    this.failures.clear(sessionId);
    this.missingSessionReported.delete(sessionId);
  }

  prune(registrations: RunnerRegistration[]): void {
    this.failures.prune(registrations);
    const present = new Set(registrations.map(({ config }) => config.sessionId));
    for (const sessionId of this.missingSessionReported.keys()) {
      if (!present.has(sessionId)) this.missingSessionReported.delete(sessionId);
    }
  }

  failure(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition,
    error: unknown,
  ): void {
    const sessionId = registration.config.sessionId;
    const logContext = this.record(registration, disposition, error);
    if (!logContext) return;
    this.options.logger.error(
      { err: error, sessionId, disposition, ...logContext },
      "runner recovery action failed",
    );
  }

  classification(registration: RunnerRegistration, error: unknown): void {
    const sessionId = registration.config.sessionId;
    const logContext = this.record(registration, "classification", error);
    if (!logContext) return;
    this.options.logger.error(
      { err: error, sessionId, ...logContext },
      "runner recovery classification failed",
    );
  }

  hydration(outcome: RunnerRecoveryHydrationOutcome): void {
    const { registration, disposition } = outcome;
    const sessionId = registration.config.sessionId;
    if (outcome.status === "ready") {
      this.missingSessionReported.delete(sessionId);
      return;
    }
    if (outcome.status === "missing") {
      const registrationId = registration.registrationId ?? null;
      if (this.missingSessionReported.get(sessionId) !== registrationId) {
        this.options.logger.warn(
          { sessionId },
          "runner registration has no durable session",
        );
        this.missingSessionReported.set(sessionId, registrationId);
      }
      this.failures.clear(sessionId);
      return;
    }
    if (outcome.status === "failed" && !outcome.retryable) {
      this.failure(registration, disposition, outcome.error);
      return;
    }
    const logContext = this.record(registration, disposition, outcome.error);
    if (!logContext) return;
    this.options.logger.warn(
      { err: outcome.error, sessionId, disposition, ...logContext },
      "runner recovery hydration deferred",
    );
  }

  private record(
    registration: RunnerRegistration,
    disposition: RunnerRecoveryDisposition | "classification",
    error: unknown,
  ) {
    return this.failures.record(
      registration.config.sessionId,
      recoveryFailureFingerprint(registration, disposition, error),
      this.options.now(),
    );
  }
}
