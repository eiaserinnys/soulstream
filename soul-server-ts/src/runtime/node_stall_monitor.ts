import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import type { Logger } from "pino";

import type {
  RunnerSqliteTransactionEvent,
  RunnerSqliteTransactionObserver,
} from "../runner/runner_sqlite_connection.js";

const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const EVENT_LOOP_DELAY_LOG_INTERVAL_MS = 60_000;
const EVENT_LOOP_DELAY_WARNING_THRESHOLD_MS = 1_000;
const WATCHDOG_PING_INTERVAL_MS = 1_000;
const WATCHDOG_STALL_THRESHOLD_MS = 2_000;
const RECENT_SQLITE_TRANSACTION_LIMIT = 32;

export interface EventLoopDelayHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
  readonly max: number;
}

export interface RunnerOperationContext {
  sessionId: string;
  commandId: string;
  operation: string;
  startedAtMonoMs?: number;
}

interface ObservedSqliteTransaction extends RunnerSqliteTransactionEvent {
  stages: Array<Pick<
    RunnerSqliteTransactionEvent,
    | "attempt"
    | "stage"
    | "attemptStartedAtMonoMs"
    | "observedAtMonoMs"
    | "elapsedMs"
    | "attemptElapsedMs"
    | "retryDelayMs"
    | "errorCode"
  >>;
}

export interface NodeStallMonitorOptions {
  logger: Pick<Logger, "info" | "warn">;
  histogram?: EventLoopDelayHistogram;
  histogramIntervalMs?: number;
  eventLoopWarningThresholdMs?: number;
  watchdogEnabled?: boolean;
  watchdogPingIntervalMs?: number;
  watchdogStallThresholdMs?: number;
  watchdogDiagnosticPath?: string;
}

export interface NodeStallMonitor {
  readonly sqliteTransactionObserver: RunnerSqliteTransactionObserver;
  beginRunnerOperation(context: RunnerOperationContext): () => void;
  observeSqliteTransaction(event: RunnerSqliteTransactionEvent): void;
  stop(): Promise<void>;
}

export function startNodeStallMonitor(options: NodeStallMonitorOptions): NodeStallMonitor {
  return new DefaultNodeStallMonitor(options);
}

class DefaultNodeStallMonitor implements NodeStallMonitor {
  readonly sqliteTransactionObserver = (event: RunnerSqliteTransactionEvent): void => {
    this.observeSqliteTransaction(event);
  };

  private readonly histogram: EventLoopDelayHistogram;
  private readonly activeRunnerOperations = new Map<string, RunnerOperationContext>();
  private readonly activeSqliteTransactions = new Map<string, ObservedSqliteTransaction>();
  private readonly recentSqliteTransactions: ObservedSqliteTransaction[] = [];
  private readonly histogramTimer: ReturnType<typeof setInterval>;
  private readonly worker: Worker | undefined;
  private runnerOperationSequence = 0;
  private stopped = false;

  constructor(private readonly options: NodeStallMonitorOptions) {
    this.histogram = options.histogram ?? monitorEventLoopDelay({
      resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
    });
    this.histogram.enable();
    this.histogramTimer = setInterval(
      () => this.reportEventLoopDelay(),
      options.histogramIntervalMs ?? EVENT_LOOP_DELAY_LOG_INTERVAL_MS,
    );
    this.histogramTimer.unref?.();

    if (options.watchdogEnabled !== false) {
      this.worker = new Worker(WATCHDOG_WORKER_SOURCE, {
        eval: true,
        workerData: {
          pingIntervalMs: options.watchdogPingIntervalMs ?? WATCHDOG_PING_INTERVAL_MS,
          stallThresholdMs: options.watchdogStallThresholdMs ?? WATCHDOG_STALL_THRESHOLD_MS,
          diagnosticPath: options.watchdogDiagnosticPath,
        },
      });
      this.worker.on("message", (message: unknown) => {
        if (!isWatchdogPing(message)) return;
        this.worker?.postMessage({
          type: "pong",
          sequence: message.sequence,
          mainReceivedAtMonoMs: performance.now(),
        });
      });
      this.worker.on("error", (error) => {
        this.options.logger.warn({ err: error }, "node stall watchdog worker failed");
      });
      this.publishContext();
    }
  }

  beginRunnerOperation(context: RunnerOperationContext): () => void {
    const operationId = `${context.sessionId}:${context.commandId}:${++this.runnerOperationSequence}`;
    this.activeRunnerOperations.set(operationId, {
      ...context,
      startedAtMonoMs: context.startedAtMonoMs ?? performance.now(),
    });
    this.publishContext();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeRunnerOperations.delete(operationId);
      this.publishContext();
    };
  }

  observeSqliteTransaction(event: RunnerSqliteTransactionEvent): void {
    const existing = this.activeSqliteTransactions.get(event.transactionId);
    const stages = existing?.stages ?? [];
    stages.push(transactionStage(event));
    const observed: ObservedSqliteTransaction = { ...event, stages };
    if (event.stage === "completed" || event.stage === "failed") {
      this.activeSqliteTransactions.delete(event.transactionId);
      this.recentSqliteTransactions.push(observed);
      if (this.recentSqliteTransactions.length > RECENT_SQLITE_TRANSACTION_LIMIT) {
        this.recentSqliteTransactions.shift();
      }
    } else {
      this.activeSqliteTransactions.set(event.transactionId, observed);
    }
    if (event.stage === "retry_wait") {
      this.options.logger.warn(
        { runnerSqliteTransaction: observed },
        "runner SQLite transaction busy; retrying after yielding the event loop",
      );
    } else if (event.stage === "failed") {
      this.options.logger.warn(
        { runnerSqliteTransaction: observed },
        "runner SQLite transaction failed",
      );
    }
    this.publishContext();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.histogramTimer);
    this.histogram.disable();
    if (this.worker) {
      this.worker.postMessage({ type: "stop" });
      await this.worker.terminate();
    }
  }

  private reportEventLoopDelay(): void {
    const eventLoopDelayMs = {
      p50: nanosecondsToMilliseconds(this.histogram.percentile(50)),
      p99: nanosecondsToMilliseconds(this.histogram.percentile(99)),
      max: nanosecondsToMilliseconds(this.histogram.max),
    };
    const context = {
      eventLoopDelayMs,
      activeRunnerOperations: [...this.activeRunnerOperations.values()],
      activeSqliteTransactions: [...this.activeSqliteTransactions.values()],
      recentSqliteTransactions: [...this.recentSqliteTransactions],
    };
    const threshold = this.options.eventLoopWarningThresholdMs
      ?? EVENT_LOOP_DELAY_WARNING_THRESHOLD_MS;
    if (eventLoopDelayMs.max >= threshold) {
      this.options.logger.warn(context, "node event loop delay threshold exceeded");
    } else {
      this.options.logger.info(context, "node event loop delay summary");
    }
    this.recentSqliteTransactions.length = 0;
    this.histogram.reset();
  }

  private publishContext(): void {
    this.worker?.postMessage({
      type: "context",
      activeRunnerOperations: [...this.activeRunnerOperations.values()],
      activeSqliteTransactions: [...this.activeSqliteTransactions.values()],
      recentSqliteTransactions: [...this.recentSqliteTransactions],
    });
  }
}

function transactionStage(event: RunnerSqliteTransactionEvent): ObservedSqliteTransaction["stages"][number] {
  return {
    attempt: event.attempt,
    stage: event.stage,
    attemptStartedAtMonoMs: event.attemptStartedAtMonoMs,
    observedAtMonoMs: event.observedAtMonoMs,
    elapsedMs: event.elapsedMs,
    attemptElapsedMs: event.attemptElapsedMs,
    ...(event.retryDelayMs !== undefined ? { retryDelayMs: event.retryDelayMs } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
}

function nanosecondsToMilliseconds(value: number): number {
  return Math.round((value / 1_000_000) * 1_000) / 1_000;
}

function isWatchdogPing(value: unknown): value is {
  type: "ping";
  sequence: number;
  sentAtMonoMs: number;
} {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { type?: unknown; sequence?: unknown; sentAtMonoMs?: unknown };
  return message.type === "ping"
    && Number.isSafeInteger(message.sequence)
    && typeof message.sentAtMonoMs === "number";
}

const WATCHDOG_WORKER_SOURCE = String.raw`
  const { appendFileSync, writeSync } = require("node:fs");
  const { hostname } = require("node:os");
  const { performance } = require("node:perf_hooks");
  const { parentPort, workerData } = require("node:worker_threads");

  const pending = new Map();
  let sequence = 0;
  let context = {
    activeRunnerOperations: [],
    activeSqliteTransactions: [],
    recentSqliteTransactions: [],
  };
  let stall = null;

  function writeDiagnostic(record) {
    const line = JSON.stringify({
      level: 40,
      time: Date.now(),
      pid: process.pid,
      hostname: hostname(),
      source: "node-stall-watchdog",
      ...record,
    }) + "\n";
    if (workerData.diagnosticPath) appendFileSync(workerData.diagnosticPath, line, "utf8");
    else writeSync(2, line);
  }

  function ping() {
    const sentAtMonoMs = performance.now();
    sequence += 1;
    pending.set(sequence, sentAtMonoMs);
    parentPort.postMessage({ type: "ping", sequence, sentAtMonoMs });
  }

  function inspect() {
    const oldest = pending.entries().next().value;
    if (!oldest) return;
    const [oldestSequence, sentAtMonoMs] = oldest;
    const stalledForMs = performance.now() - sentAtMonoMs;
    if (stalledForMs < workerData.stallThresholdMs) return;
    if (!stall) {
      stall = {
        oldestSequence,
        detectedAtMonoMs: performance.now(),
        maxRoundTripMs: stalledForMs,
      };
      writeDiagnostic({
        msg: "main thread stall detected",
        stalledForMs,
        detectedAtMonoMs: stall.detectedAtMonoMs,
        ...context,
      });
    } else {
      stall.maxRoundTripMs = Math.max(stall.maxRoundTripMs, stalledForMs);
    }
  }

  const timer = setInterval(() => {
    ping();
    inspect();
  }, workerData.pingIntervalMs);
  timer.unref();
  ping();

  parentPort.on("message", (message) => {
    if (message?.type === "context") {
      context = {
        activeRunnerOperations: message.activeRunnerOperations ?? [],
        activeSqliteTransactions: message.activeSqliteTransactions ?? [],
        recentSqliteTransactions: message.recentSqliteTransactions ?? [],
      };
      return;
    }
    if (message?.type === "pong") {
      const sentAtMonoMs = pending.get(message.sequence);
      if (sentAtMonoMs === undefined) return;
      const roundTripMs = performance.now() - sentAtMonoMs;
      pending.delete(message.sequence);
      if (stall && message.sequence >= stall.oldestSequence) {
        stall.maxRoundTripMs = Math.max(stall.maxRoundTripMs, roundTripMs);
        writeDiagnostic({
          msg: "main thread stall recovered",
          detectedAtMonoMs: stall.detectedAtMonoMs,
          recoveredAtMonoMs: performance.now(),
          maxRoundTripMs: stall.maxRoundTripMs,
          mainReceivedAtMonoMs: message.mainReceivedAtMonoMs,
          ...context,
        });
        stall = null;
      }
      return;
    }
    if (message?.type === "stop") {
      clearInterval(timer);
      process.exit(0);
    }
  });
`;
