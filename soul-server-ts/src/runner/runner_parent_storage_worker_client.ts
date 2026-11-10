import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { Worker } from "node:worker_threads";

import type { ClaudeAccountTurnState } from "../engine/claude_account_pool.js";
import type { ClosedRunnerTailState } from "./closed_runner_tail_state.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";
import {
  deserializeRunnerParentStorageError,
  type RunnerParentStorageBatch,
  type RunnerParentStorageBootstrap,
  type RunnerParentStorageFallback,
  type RunnerParentStorageInterventionInspection,
  type RunnerParentStorageLifecycleSummaryNotice,
  type RunnerParentStorageObservation,
  type RunnerParentStorageOperation,
  type RunnerParentStorageOperationMap,
  type RunnerParentStorageOutboxOpenInput,
  type RunnerParentStoragePendingFrame,
  type RunnerParentStorageQuarantineInput,
  type RunnerParentStorageQuarantineResult,
  type RunnerParentStorageReceipt,
  type RunnerParentStorageRecord,
  type RunnerParentStorageRecoveryInput,
  type RunnerParentStorageRequest,
  type RunnerParentStorageResponse,
  type RunnerParentStorageSnapshot,
  type RunnerParentStorageWorkerMessage,
} from "./runner_parent_storage_protocol.js";
import type {
  RunnerDurableInspection,
  RunnerDurableRetentionProbe,
  RunnerRegistration,
} from "./runner_process_registry.js";
import type { RecoveredRunnerIdentity } from "./runner_registration_identity.js";
import type { RunnerSqliteTransactionObserver } from "./runner_sqlite_connection.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

export interface RunnerParentStorageWorkerClientOptions {
  databasePath?: string;
  sessionId?: string;
  phaseObservation?: RunnerPhaseObservation;
  transactionObserver?: RunnerSqliteTransactionObserver;
  workerFactory?: (workerData: Record<string, unknown>) => Worker;
}

/** Parent-only observation for one request; never sent over the wire. */
export interface RunnerParentStorageRequestObservation {
  phaseObservation?: RunnerPhaseObservation;
  transactionObserver?: RunnerSqliteTransactionObserver;
  databasePath?: string;
  sessionId?: string;
  onSummaryNotice?: (notice: RunnerParentStorageLifecycleSummaryNotice) => void;
}

export interface RunnerParentStorageSnapshotResult<T> {
  value: T;
  snapshot?: RunnerParentStorageSnapshot;
}

type ClientState = "opening" | "open" | "closing" | "closed" | "failed";

interface PendingRequest {
  resolve: (result: { value: unknown; snapshot?: RunnerParentStorageSnapshot }) => void;
  reject: (error: Error) => void;
  observation?: RunnerParentStorageRequestObservation;
  failure?: Error;
}

interface OpenPhase {
  requestId: number;
  phase: string;
  settle: (error?: Error) => void;
}

const WORKER_ENTRY_CANDIDATES = [
  "./runner_parent_storage_worker_entry.js",
  "./runner/runner_parent_storage_worker_entry.js",
  "./runner_parent_storage_worker_entry.ts",
];

export class RunnerParentStorageWorkerClient {
  private readonly clientId = randomUUID();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openPhases = new Map<number, OpenPhase>();
  private readonly workerPhaseElapsedMs = new Map<string, number>();
  private state: ClientState = "opening";
  private worker: Worker | undefined;
  private nextRequestId = 0;
  private closeRequestId: number | undefined;
  private closeResponseReceived = false;
  private closePromise: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;
  private closeReject: ((error: Error) => void) | undefined;
  private exitCode: number | undefined;
  private finished = false;
  private terminalError: Error | undefined;

  constructor(private readonly options: RunnerParentStorageWorkerClientOptions) {}

  async open(
    input: RunnerParentStorageOutboxOpenInput,
  ): Promise<RunnerParentStorageSnapshot> {
    await this.startWorker();
    const result = await this.request("open", input);
    this.state = "open";
    return this.requireSnapshot(result.snapshot, "open");
  }

  async openRecovery(): Promise<void> {
    await this.startWorker();
    await this.request("open", { mode: "recovery" });
    this.state = "open";
  }

  isTerminal(): boolean {
    return this.state === "failed" || this.state === "closed";
  }

  async disposeAfterOpenFailure(): Promise<void> {
    this.state = "closed";
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    try {
      await worker.terminate();
    } catch {
      // The worker may already be gone after a transport failure.
    }
  }

  async readBootstrap(): Promise<
    RunnerParentStorageSnapshotResult<RunnerParentStorageBootstrap | null>
  > {
    return await this.request("readBootstrap", undefined);
  }

  async readBatch(
    maxEvents?: number,
  ): Promise<RunnerParentStorageSnapshotResult<RunnerParentStorageBatch | null>> {
    return await this.request("readBatch", { maxEvents });
  }

  async acknowledge(
    streamId: string,
    acknowledgedThrough: number,
  ): Promise<RunnerParentStorageSnapshot> {
    const result = await this.request("acknowledge", { streamId, acknowledgedThrough });
    return this.requireSnapshot(result.snapshot, "acknowledge");
  }

  async quarantineHead(
    input: RunnerParentStorageQuarantineInput,
  ): Promise<RunnerParentStorageSnapshotResult<RunnerParentStorageQuarantineResult>> {
    const result = await this.request("quarantineHead", input);
    return { value: result.value, snapshot: this.requireSnapshot(result.snapshot, "quarantineHead") };
  }

  async readRecord(sourceSeq: number): Promise<RunnerParentStorageRecord | null> {
    return (await this.request("readRecord", { sourceSeq })).value;
  }

  async readLatestPendingRecord(): Promise<
    RunnerParentStorageSnapshotResult<RunnerParentStorageRecord | null>
  > {
    return await this.request("readLatestPendingRecord", undefined);
  }

  async readPendingIpcFrames(): Promise<RunnerParentStoragePendingFrame[]> {
    return (await this.request("readPendingIpcFrames", undefined)).value;
  }

  async inspectPendingInterventions(): Promise<RunnerParentStorageInterventionInspection> {
    return (await this.request("inspectPendingInterventions", undefined)).value;
  }

  async readInterventionFallback(
    interventionId: string,
  ): Promise<RunnerParentStorageFallback | null> {
    return (await this.request("readInterventionFallback", { interventionId })).value;
  }

  async removeInterventionFallback(interventionId: string): Promise<void> {
    await this.request("removeInterventionFallback", { interventionId });
  }

  async hasPendingDurableWork(): Promise<RunnerParentStorageSnapshotResult<boolean>> {
    return await this.request("hasPendingDurableWork", undefined);
  }

  async readHostCallApplied(
    correlationId: string,
  ): Promise<RunnerParentStorageReceipt | null> {
    return (await this.request("readHostCallApplied", { correlationId })).value;
  }

  async recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): Promise<void> {
    await this.request("recordHostCallApplied", input);
  }

  async acknowledgeHostCall(correlationId: string): Promise<void> {
    await this.request("acknowledgeHostCall", { correlationId });
  }

  async readLifecycle(
    input: RunnerParentStorageRecoveryInput,
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<RunnerLifecycleRecord | null> {
    return (await this.request("readLifecycle", input, observation)).value;
  }

  async readAuthoritativeLifecycle(
    input: RunnerParentStorageRecoveryInput,
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<RunnerLifecycleRecord | null> {
    return (await this.request("readAuthoritativeLifecycle", input, observation)).value;
  }

  async readClosedTail(
    input: { databasePath: string; sessionId: string },
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<ClosedRunnerTailState> {
    return (await this.request("readClosedTail", input, observation)).value;
  }

  async readSqliteIdentity(
    input: { databasePath: string },
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<RecoveredRunnerIdentity | null> {
    return (await this.request("readSqliteIdentity", input, observation)).value;
  }

  async inspectDurableState(
    input: { registration: RunnerRegistration },
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<RunnerDurableInspection> {
    return (await this.request("inspectDurableState", input, observation)).value;
  }

  async probeDurableRetention(
    input: { registration: RunnerRegistration },
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<RunnerDurableRetentionProbe> {
    return (await this.request("probeDurableRetention", input, observation)).value;
  }

  async readClaudeAccountTurnState(
    input: { databasePath: string; sessionId: string },
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<ClaudeAccountTurnState | null> {
    return (await this.request("readClaudeAccountTurnState", input, observation)).value;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "failed") {
      this.closePromise = Promise.reject(this.terminalError);
      return this.closePromise;
    }
    if (this.state === "closed") {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.state = "closing";
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
    });
    const worker = this.worker;
    if (!worker) {
      this.fail(new Error("runner parent storage worker is not started"));
      return this.closePromise;
    }
    const requestId = ++this.nextRequestId;
    this.closeRequestId = requestId;
    try {
      worker.postMessage({
        type: "request",
        requestId,
        operation: "close",
        input: undefined,
      } satisfies RunnerParentStorageRequest);
    } catch (error) {
      this.fail(new Error("runner parent storage worker postMessage failed", { cause: error }));
    }
    return this.closePromise;
  }

  workerPhaseDurationsMs(): Record<string, number> {
    return Object.fromEntries(this.workerPhaseElapsedMs);
  }

  private async startWorker(): Promise<void> {
    this.state = "opening";
    this.worker = await this.createWorker();
    this.attachWorker(this.worker);
  }

  private async createWorker(): Promise<Worker> {
    const workerData: Record<string, unknown> = {};
    if (this.options.workerFactory) return this.options.workerFactory(workerData);
    const entryUrl = await resolveWorkerEntryUrl();
    if (entryUrl.pathname.endsWith(".js")) {
      return new Worker(entryUrl, { workerData });
    }
    const source = `
      const { pathToFileURL } = require("node:url");
      import("tsx/esm/api").then(({ tsImport }) =>
        tsImport(${JSON.stringify(entryUrl.href)}, pathToFileURL(process.cwd() + "/").href)
      ).catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `;
    return new Worker(source, { eval: true, workerData });
  }

  private attachWorker(worker: Worker): void {
    worker.on("message", (message: RunnerParentStorageWorkerMessage) => {
      this.handleMessage(message);
    });
    worker.on("error", (error: Error) => {
      this.handleError(error);
    });
    worker.on("exit", (code: number) => {
      this.handleExit(code);
    });
  }

  private async request<K extends RunnerParentStorageOperation>(
    operation: K,
    input: RunnerParentStorageOperationMap[K]["input"],
    observation?: RunnerParentStorageRequestObservation,
  ): Promise<RunnerParentStorageSnapshotResult<RunnerParentStorageOperationMap[K]["output"]>> {
    if (this.state === "failed") {
      return Promise.reject(this.terminalError);
    }
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(new Error(`runner parent storage worker is ${this.state}`));
    }
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error("runner parent storage worker is not started"));
    }
    const requestId = ++this.nextRequestId;
    const inner = new Promise<{ value: unknown; snapshot?: RunnerParentStorageSnapshot }>(
      (resolve, reject) => {
        this.pending.set(requestId, {
          resolve: resolve as PendingRequest["resolve"],
          reject,
          ...(observation ? { observation } : {}),
        });
      },
    );
    const phaseObservation = observation?.phaseObservation ?? this.options.phaseObservation;
    const sessionId = observation?.sessionId ?? this.options.sessionId;
    const databasePath = observation?.databasePath ?? this.options.databasePath;
    const wait = phaseObservation
      ? phaseObservation.runAsync("dbWorkerWait", {
        ...(sessionId ? { sessionId } : {}),
        ...(databasePath ? { databasePath } : {}),
        label: `runner parent storage ${operation}`,
      }, async () => await inner)
      : inner;
    try {
      // The generic call site keeps `operation` and `input` correlated; the
      // request union cannot express that correlation through a type parameter.
      const request = {
        type: "request",
        requestId,
        operation,
        input,
      } as unknown as RunnerParentStorageRequest;
      worker.postMessage(request);
    } catch (error) {
      this.fail(new Error("runner parent storage worker postMessage failed", { cause: error }));
    }
    return await (wait as Promise<
      RunnerParentStorageSnapshotResult<RunnerParentStorageOperationMap[K]["output"]>
    >);
  }

  private handleMessage(message: RunnerParentStorageWorkerMessage): void {
    if (this.finished) return;
    switch (message.type) {
      case "result":
        this.handleResult(message);
        break;
      case "phase_begin":
        this.handlePhaseBegin(message);
        break;
      case "phase_end":
        this.handlePhaseEnd(message);
        break;
      case "transaction":
        this.handleTransaction(message);
        break;
      case "summary_notice":
        this.handleSummaryNotice(message);
        break;
    }
  }

  private handleResult(message: RunnerParentStorageResponse): void {
    if (message.requestId === this.closeRequestId) {
      this.handleCloseResult(message);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve({
        value: message.value,
        ...(message.snapshot ? { snapshot: message.snapshot } : {}),
      });
      return;
    }
    pending.reject(
      pending.failure ?? deserializeRunnerParentStorageError(message.error),
    );
  }

  private handleCloseResult(message: RunnerParentStorageResponse): void {
    if (!message.ok) {
      this.finished = true;
      this.state = "closed";
      this.settleClose(deserializeRunnerParentStorageError(message.error));
      return;
    }
    this.closeResponseReceived = true;
    if (this.exitCode !== undefined) {
      this.finishCloseWithExit(this.exitCode);
    }
  }

  private handlePhaseBegin(
    message: Extract<RunnerParentStorageObservation, { type: "phase_begin" }>,
  ): void {
    let settle: (error?: Error) => void = () => {};
    const phaseObservation = this.pending.get(message.requestId)?.observation?.phaseObservation
      ?? this.options.phaseObservation;
    if (phaseObservation) {
      let settlePhase!: (error?: Error) => void;
      const settled = new Promise<void>((resolve, reject) => {
        settlePhase = (error?: Error) => {
          if (error) reject(error);
          else resolve();
        };
      });
      const run = phaseObservation.runAsync(
        message.phase,
        message.context,
        async () => await settled,
      );
      run.catch(() => {});
      settle = settlePhase;
    }
    this.openPhases.set(message.phaseId, {
      requestId: message.requestId,
      phase: message.phase,
      settle,
    });
  }

  private handlePhaseEnd(
    message: Extract<RunnerParentStorageObservation, { type: "phase_end" }>,
  ): void {
    const phase = this.openPhases.get(message.phaseId);
    if (!phase) return;
    this.openPhases.delete(message.phaseId);
    this.workerPhaseElapsedMs.set(
      phase.phase,
      (this.workerPhaseElapsedMs.get(phase.phase) ?? 0) + message.elapsedMs,
    );
    if (!message.error) {
      phase.settle();
      return;
    }
    const pending = this.pending.get(phase.requestId);
    if (pending?.failure) {
      phase.settle(pending.failure);
      return;
    }
    const error = deserializeRunnerParentStorageError(message.error);
    if (pending) pending.failure = error;
    phase.settle(error);
  }

  private handleTransaction(
    message: Extract<RunnerParentStorageObservation, { type: "transaction" }>,
  ): void {
    const observer = this.pending.get(message.requestId)?.observation?.transactionObserver
      ?? this.options.transactionObserver;
    if (!observer) return;
    try {
      observer({
        ...message.event,
        transactionId: `${this.clientId}:${message.event.transactionId}`,
      });
    } catch {
      // Observation failures never change storage results.
    }
  }

  private handleSummaryNotice(message: RunnerParentStorageLifecycleSummaryNotice): void {
    const notify = this.pending.get(message.requestId)?.observation?.onSummaryNotice;
    if (!notify) return;
    try {
      notify(message);
    } catch {
      // Observation failures never change storage results.
    }
  }

  private handleError(error: Error): void {
    if (this.finished) return;
    this.fail(new Error("runner parent storage worker failed", { cause: error }));
  }

  private handleExit(code: number): void {
    this.exitCode = code;
    if (this.finished) return;
    if (this.state === "closing") {
      if (this.closeResponseReceived) {
        this.finishCloseWithExit(code);
        return;
      }
      this.fail(
        new Error("runner parent storage worker exited before completing the close request"),
      );
      return;
    }
    this.fail(
      new Error("runner parent storage worker exited before completing the request"),
    );
  }

  private finishCloseWithExit(code: number): void {
    if (code === 0) {
      this.finished = true;
      this.state = "closed";
      this.settleClose();
      return;
    }
    this.fail(
      new Error(`runner parent storage worker exited with code ${code} before completing close`),
    );
  }

  private fail(error: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.terminalError = error;
    this.state = "failed";
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const phase of this.openPhases.values()) phase.settle(error);
    this.openPhases.clear();
    this.settleClose(error);
    const worker = this.worker;
    if (worker) {
      void worker.terminate().catch(() => {});
    }
  }

  private settleClose(error?: Error): void {
    const resolve = this.closeResolve;
    const reject = this.closeReject;
    this.closeResolve = undefined;
    this.closeReject = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private requireSnapshot(
    snapshot: RunnerParentStorageSnapshot | undefined,
    operation: string,
  ): RunnerParentStorageSnapshot {
    if (!snapshot) {
      throw new Error(`runner parent storage worker did not report a snapshot for ${operation}`);
    }
    return snapshot;
  }
}

async function resolveWorkerEntryUrl(): Promise<URL> {
  const candidates = WORKER_ENTRY_CANDIDATES.map(
    (candidate) => new URL(candidate, import.meta.url),
  );
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error("runner parent storage worker entry is missing");
}
