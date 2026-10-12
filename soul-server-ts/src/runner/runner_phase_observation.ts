import { performance } from "node:perf_hooks";

import type { Logger } from "pino";

import type { RunnerOperationContext } from "../runtime/node_stall_monitor.js";

export type RunnerDatabaseObservationPhase = "dbOpen" | "dbRead";

export interface RunnerPhaseContext {
  sessionId?: string;
  commandId?: string;
  databasePath?: string;
  label?: string;
}

export interface RunnerDatabaseObservationContext extends RunnerPhaseContext {
  phaseObservation: RunnerPhaseObservation;
}

export interface RunnerDatabaseObservationSample {
  phase: RunnerDatabaseObservationPhase;
  sessionId?: string;
  databasePath?: string;
  label?: string;
  elapsedMs: number;
  outcome: "ok" | "failed";
}

export interface RunnerDatabaseObservationSummary {
  counts: Record<RunnerDatabaseObservationPhase, number>;
  totalMs: Record<RunnerDatabaseObservationPhase, number>;
  maxMs: Record<RunnerDatabaseObservationPhase, number>;
  failures: Record<RunnerDatabaseObservationPhase, number>;
  recentSamples: RunnerDatabaseObservationSample[];
}

export interface RunnerPhaseFailure {
  phase: string;
  elapsedMs: number;
}

export interface RunnerPhaseObservation {
  runSync<T>(phase: string, context: RunnerPhaseContext, action: () => T): T;
  runAsync<T>(
    phase: string,
    context: RunnerPhaseContext,
    action: () => Promise<T>,
  ): Promise<T>;
  phaseDurationsMs(): Record<string, number>;
  databaseSummary(): RunnerDatabaseObservationSummary | undefined;
  failureFor(error: unknown): RunnerPhaseFailure | undefined;
}

export interface CreateRunnerPhaseObservationOptions {
  nodeId: string;
  scopeId: string;
  operation: string;
  logger: Pick<Logger, "warn">;
  monotonicNow?: () => number;
  beginRunnerOperation?: (context: RunnerOperationContext) => () => void;
}

const RECENT_DATABASE_SAMPLE_LIMIT = 32;

export function createRunnerPhaseObservation(
  options: CreateRunnerPhaseObservationOptions,
): RunnerPhaseObservation {
  const durations: Record<string, number> = {};
  const databaseSummary: RunnerDatabaseObservationSummary = {
    counts: { dbOpen: 0, dbRead: 0 },
    totalMs: { dbOpen: 0, dbRead: 0 },
    maxMs: { dbOpen: 0, dbRead: 0 },
    failures: { dbOpen: 0, dbRead: 0 },
    recentSamples: [],
  };
  let lastFailure: { error: unknown; value: RunnerPhaseFailure } | undefined;
  let warningEmitted = false;

  const warnObservationFailure = (error: unknown): void => {
    if (warningEmitted) return;
    warningEmitted = true;
    try {
      options.logger.warn({ err: error }, "runner phase observation failed");
    } catch {
      // Observation reporting must not replace the product result or error.
    }
  };

  const monotonicNow = (): number | undefined => {
    try {
      const value = (options.monotonicNow ?? defaultMonotonicNow)();
      return Number.isFinite(value) ? value : undefined;
    } catch (error) {
      warnObservationFailure(error);
      return undefined;
    }
  };

  const begin = (
    phase: string,
    context: RunnerPhaseContext,
    startedAtMonoMs: number | undefined,
  ): (() => void) | undefined => {
    if (!options.beginRunnerOperation) return undefined;
    try {
      const operationContext: RunnerOperationContext = {
        sessionId: context.sessionId ?? `runner-recovery:${options.scopeId}`,
        commandId: context.commandId ?? options.scopeId,
        operation: `${options.operation}.${phase}${context.label ? `.${context.label}` : ""}`,
        nodeId: options.nodeId,
        scanId: options.scopeId,
        phase,
        ...(context.databasePath ? { databasePath: context.databasePath } : {}),
        ...(startedAtMonoMs !== undefined ? { startedAtMonoMs } : {}),
      };
      return options.beginRunnerOperation(operationContext);
    } catch (error) {
      warnObservationFailure(error);
      return undefined;
    }
  };

  const finish = (finishOperation: (() => void) | undefined): void => {
    try {
      finishOperation?.();
    } catch (error) {
      warnObservationFailure(error);
    }
  };

  const elapsed = (startedAt: number | undefined): number | undefined => {
    if (startedAt === undefined) return undefined;
    const endedAt = monotonicNow();
    return endedAt === undefined ? undefined : Math.max(0, endedAt - startedAt);
  };

  const record = (
    phase: string,
    context: RunnerPhaseContext,
    durationMs: number | undefined,
    outcome: "ok" | "failed",
  ): void => {
    if (durationMs === undefined) return;
    try {
      if (phase === "dbOpen" || phase === "dbRead") {
        databaseSummary.counts[phase] += 1;
        databaseSummary.totalMs[phase] += durationMs;
        databaseSummary.maxMs[phase] = Math.max(databaseSummary.maxMs[phase], durationMs);
        if (outcome === "failed") databaseSummary.failures[phase] += 1;
        databaseSummary.recentSamples.push({
          phase,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.databasePath ? { databasePath: context.databasePath } : {}),
          ...(context.label ? { label: context.label } : {}),
          elapsedMs: durationMs,
          outcome,
        });
        if (databaseSummary.recentSamples.length > RECENT_DATABASE_SAMPLE_LIMIT) {
          databaseSummary.recentSamples.shift();
        }
        return;
      }
      durations[phase] = (durations[phase] ?? 0) + durationMs;
    } catch (error) {
      warnObservationFailure(error);
    }
  };

  const recordFailure = (
    error: unknown,
    phase: string,
    durationMs: number | undefined,
  ): void => {
    if (lastFailure?.error === error) return;
    lastFailure = {
      error,
      value: { phase, elapsedMs: durationMs ?? 0 },
    };
  };

  return {
    runSync<T>(phase: string, context: RunnerPhaseContext, action: () => T): T {
      const startedAt = monotonicNow();
      const finishOperation = begin(phase, context, startedAt);
      let outcome: "ok" | "failed" = "ok";
      let didFail = false;
      let actionError: unknown;
      try {
        return action();
      } catch (error) {
        outcome = "failed";
        didFail = true;
        actionError = error;
        throw error;
      } finally {
        const durationMs = elapsed(startedAt);
        if (didFail) recordFailure(actionError, phase, durationMs);
        record(phase, context, durationMs, outcome);
        finish(finishOperation);
      }
    },

    async runAsync<T>(
      phase: string,
      context: RunnerPhaseContext,
      action: () => Promise<T>,
    ): Promise<T> {
      const startedAt = monotonicNow();
      const finishOperation = begin(phase, context, startedAt);
      let outcome: "ok" | "failed" = "ok";
      let didFail = false;
      let actionError: unknown;
      try {
        return await action();
      } catch (error) {
        outcome = "failed";
        didFail = true;
        actionError = error;
        throw error;
      } finally {
        const durationMs = elapsed(startedAt);
        if (didFail) recordFailure(actionError, phase, durationMs);
        record(phase, context, durationMs, outcome);
        finish(finishOperation);
      }
    },

    phaseDurationsMs(): Record<string, number> {
      return { ...durations };
    },

    databaseSummary(): RunnerDatabaseObservationSummary | undefined {
      return databaseSummary.counts.dbOpen + databaseSummary.counts.dbRead > 0
        ? {
          counts: { ...databaseSummary.counts },
          totalMs: { ...databaseSummary.totalMs },
          maxMs: { ...databaseSummary.maxMs },
          failures: { ...databaseSummary.failures },
          recentSamples: databaseSummary.recentSamples.map((sample) => ({ ...sample })),
        }
        : undefined;
    },

    failureFor(error): RunnerPhaseFailure | undefined {
      if (!lastFailure || lastFailure.error !== error) return undefined;
      return { ...lastFailure.value };
    },
  };
}

function defaultMonotonicNow(): number {
  return performance.now();
}
