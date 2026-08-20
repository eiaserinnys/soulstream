import type { Logger } from "pino";

import { withDeadline } from "./deadline.js";

/**
 * Canonical periodic maintenance lane.
 *
 * Every maintenance poller in this process shares one failure mode: a timer
 * fires on a fixed interval, a re-entrancy gate suppresses overlapping ticks,
 * and the gate is only cleared when the previous tick settles. A step that
 * never settles therefore converts the whole lane into a silent no-op — the
 * timer keeps firing, the gate keeps rejecting, and nothing is ever logged.
 *
 * This loop owns the three guarantees that make that impossible:
 *
 * 1. every step runs under its own deadline, so a tick is bounded by the sum
 *    of its step deadlines regardless of what the steps do;
 * 2. a step whose underlying promise is still outstanding from a previous tick
 *    is skipped rather than started again, so a permanently hung operation
 *    neither blocks its siblings nor accumulates — unless the step declares
 *    that missing it costs more than repeating it;
 * 3. a tick that outlives its deadline anyway is abandoned and re-scheduled.
 *
 * Every one of those events is logged at error level, and the lane emits a
 * periodic liveness summary, so a stalled lane is visible both by what appears
 * in the log and by what stops appearing.
 */

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_LIVENESS_INTERVAL_MS = 60_000;

export class MaintenanceStepTimeoutError extends Error {
  constructor(
    readonly lane: string,
    readonly stepName: string,
    readonly timeoutMs: number,
  ) {
    super(`Maintenance step ${lane}.${stepName} exceeded ${timeoutMs}ms`);
    this.name = "MaintenanceStepTimeoutError";
  }
}

export interface MaintenanceStep {
  /** Stable identifier used in every log record for this step. */
  readonly name: string;
  run(): Promise<void>;
  /** Overrides the lane-level step deadline. */
  readonly timeoutMs?: number;
  /**
   * Start this step again even while an earlier invocation is still
   * outstanding.
   *
   * Skipping an outstanding step keeps a stalled dependency from piling up
   * work, which is right for an expensive drain and wrong for a cheap
   * idempotent one. A node heartbeat that is skipped rather than retried turns
   * one slow request into a node the whole cluster believes is dead — so for
   * that shape, missing the step is worse than repeating it.
   *
   * Only set this when the step's own operation is bounded; otherwise
   * invocations accumulate without limit.
   */
  readonly reissueWhileOutstanding?: boolean;
}

export interface PeriodicMaintenanceLoopOptions {
  /** Lane identifier used in every log record. */
  lane: string;
  steps: MaintenanceStep[];
  intervalMs?: number;
  /** Default per-step deadline. */
  stepTimeoutMs?: number;
  /**
   * Deadline after which an unfinished tick is abandoned and a new one is
   * started. Defaults to twice the sum of the step deadlines.
   */
  tickTimeoutMs?: number;
  /** Interval between liveness summaries. Set to 0 to disable. */
  livenessIntervalMs?: number;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** Injectable monotonic clock. Tests substitute this. */
  monotonicNowMs?: () => number;
}

interface OutstandingStep {
  startedAtMs: number;
}

interface LaneCounters {
  ticks: number;
  stepFailures: number;
  stepTimeouts: number;
  stepsSkippedWhileOutstanding: number;
  stepsReissuedWhileOutstanding: number;
  ticksAbandoned: number;
}

export class PeriodicMaintenanceLoop {
  private readonly lane: string;
  private readonly steps: MaintenanceStep[];
  private readonly intervalMs: number;
  private readonly stepTimeoutMs: number;
  private readonly tickTimeoutMs: number;
  private readonly livenessIntervalMs: number;
  private readonly logger: Pick<Logger, "info" | "warn" | "error">;
  private readonly now: () => number;

  private readonly outstanding = new Map<string, OutstandingStep>();
  private counters = emptyCounters();

  private timer?: NodeJS.Timeout;
  private livenessTimer?: NodeJS.Timeout;
  private activeTick?: Promise<void>;
  private activeTickStartedAtMs = 0;
  private activeTickStepName?: string;
  private lastTickFinishedAtMs?: number;
  private stopping = false;

  constructor(options: PeriodicMaintenanceLoopOptions) {
    if (options.steps.length === 0) {
      throw new Error(`Maintenance lane ${options.lane} declares no steps`);
    }
    const duplicate = firstDuplicateName(options.steps);
    if (duplicate) {
      throw new Error(
        `Maintenance lane ${options.lane} declares duplicate step ${duplicate}`,
      );
    }
    this.lane = options.lane;
    this.steps = [...options.steps];
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.tickTimeoutMs = options.tickTimeoutMs
      ?? 2 * this.steps.reduce(
        (total, step) => total + (step.timeoutMs ?? this.stepTimeoutMs),
        0,
      );
    this.livenessIntervalMs = options.livenessIntervalMs
      ?? DEFAULT_LIVENESS_INTERVAL_MS;
    this.logger = options.logger;
    this.now = options.monotonicNowMs ?? (() => Date.now());
  }

  /**
   * Schedules the lane and returns the first tick, so a caller that wants the
   * initial pass to complete before proceeding can await a *bounded* promise
   * instead of an open-ended one. Scheduling is installed synchronously, so
   * ignoring the returned promise never delays the lane.
   */
  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    this.stopping = false;
    const initial = this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    if (this.livenessIntervalMs > 0) {
      this.livenessTimer = setInterval(
        () => this.reportLiveness(),
        this.livenessIntervalMs,
      );
      this.livenessTimer.unref?.();
    }
    return initial;
  }

  async stop(timeoutMs = 5_000): Promise<"drained" | "timed_out"> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    // Outstanding entries belong to the run that is ending. Carrying them into
    // a restart would make its first tick skip steps for work nobody is
    // waiting on any more.
    this.outstanding.clear();
    const active = this.activeTick;
    if (!active) return "drained";
    return await Promise.race([
      active.then(() => "drained" as const),
      new Promise<"timed_out">((resolve) => {
        const timer = setTimeout(() => resolve("timed_out"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  /**
   * Runs one tick and resolves when it finishes.
   *
   * Overlapping calls are suppressed while the active tick is inside its
   * deadline. Past that deadline the active tick is abandoned — never awaited
   * again — so a wedged tick cannot silence the lane.
   */
  async runOnce(): Promise<void> {
    if (this.stopping) return;
    if (this.activeTick) {
      const elapsedMs = this.now() - this.activeTickStartedAtMs;
      if (elapsedMs < this.tickTimeoutMs) return;
      this.counters.ticksAbandoned += 1;
      this.logger.error(
        {
          lane: this.lane,
          elapsedMs,
          tickTimeoutMs: this.tickTimeoutMs,
          stuckStep: this.activeTickStepName,
          outstandingSteps: this.outstandingSnapshot(),
        },
        "Maintenance tick exceeded its deadline; abandoning it and forcing a new tick",
      );
      this.activeTick = undefined;
      this.activeTickStepName = undefined;
    }
    const tick = this.runTick();
    this.activeTick = tick;
    this.activeTickStartedAtMs = this.now();
    const settle = (): void => {
      // A tick abandoned by the watchdog has already been replaced; it must not
      // clear the gate belonging to its successor.
      if (this.activeTick !== tick) return;
      this.activeTick = undefined;
      this.activeTickStepName = undefined;
      this.lastTickFinishedAtMs = this.now();
    };
    try {
      await tick;
    } finally {
      settle();
    }
  }

  private async runTick(): Promise<void> {
    this.counters.ticks += 1;
    for (const step of this.steps) {
      if (this.stopping) return;
      this.activeTickStepName = step.name;
      await this.runStep(step);
    }
  }

  private async runStep(step: MaintenanceStep): Promise<void> {
    const timeoutMs = step.timeoutMs ?? this.stepTimeoutMs;
    const outstanding = this.outstanding.get(step.name);
    if (outstanding) {
      const outstandingForMs = this.now() - outstanding.startedAtMs;
      if (!step.reissueWhileOutstanding) {
        this.counters.stepsSkippedWhileOutstanding += 1;
        this.logger.error(
          { lane: this.lane, step: step.name, outstandingForMs },
          "Maintenance step is still outstanding from an earlier tick; skipping it so the rest of the lane keeps running",
        );
        return;
      }
      this.counters.stepsReissuedWhileOutstanding += 1;
      this.logger.warn(
        { lane: this.lane, step: step.name, outstandingForMs },
        "Maintenance step is still outstanding from an earlier tick; re-issuing it because missing it costs more than repeating it",
      );
    }

    const startedAtMs = this.now();
    const pending = invoke(step);
    this.outstanding.set(step.name, { startedAtMs });
    const clearOutstanding = (): void => {
      // A re-issued step replaces the entry; only the newest invocation owns it.
      if (this.outstanding.get(step.name)?.startedAtMs !== startedAtMs) return;
      this.outstanding.delete(step.name);
    };
    pending.then(clearOutstanding, clearOutstanding);

    try {
      await withDeadline(pending, timeoutMs, () =>
        new MaintenanceStepTimeoutError(this.lane, step.name, timeoutMs));
    } catch (err) {
      if (err instanceof MaintenanceStepTimeoutError) {
        this.counters.stepTimeouts += 1;
        this.logger.error(
          { err, lane: this.lane, step: step.name, timeoutMs },
          "Maintenance step exceeded its deadline; the lane continues without it",
        );
        return;
      }
      this.counters.stepFailures += 1;
      this.logger.warn(
        { err, lane: this.lane, step: step.name, elapsedMs: this.now() - startedAtMs },
        "Maintenance step failed; the lane continues",
      );
    }
  }

  private reportLiveness(): void {
    const counters = this.counters;
    this.counters = emptyCounters();
    const record = {
      lane: this.lane,
      ...counters,
      outstandingSteps: this.outstandingSnapshot(),
      msSinceLastTickFinished: this.lastTickFinishedAtMs === undefined
        ? null
        : this.now() - this.lastTickFinishedAtMs,
    };
    const degraded = counters.stepTimeouts > 0
      || counters.ticksAbandoned > 0
      || counters.stepsSkippedWhileOutstanding > 0
      || counters.stepsReissuedWhileOutstanding > 0;
    if (degraded) this.logger.error(record, "Maintenance lane is degraded");
    else this.logger.info(record, "Maintenance lane liveness");
  }

  private outstandingSnapshot(): Array<{ step: string; outstandingForMs: number }> {
    const now = this.now();
    return [...this.outstanding.entries()].map(([step, entry]) => ({
      step,
      outstandingForMs: now - entry.startedAtMs,
    }));
  }
}

function invoke(step: MaintenanceStep): Promise<void> {
  try {
    return Promise.resolve(step.run());
  } catch (err) {
    return Promise.reject(err);
  }
}

function firstDuplicateName(steps: MaintenanceStep[]): string | undefined {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.name)) return step.name;
    seen.add(step.name);
  }
  return undefined;
}

function emptyCounters(): LaneCounters {
  return {
    ticks: 0,
    stepFailures: 0,
    stepTimeouts: 0,
    stepsSkippedWhileOutstanding: 0,
    stepsReissuedWhileOutstanding: 0,
    ticksAbandoned: 0,
  };
}
