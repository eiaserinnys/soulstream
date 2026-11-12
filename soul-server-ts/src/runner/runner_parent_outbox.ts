import type { Worker } from "node:worker_threads";

import type { EventOutboxBatch, EventOutboxRecord } from "../upstream/event_outbox.js";
import type { EventOutboxPumpStore } from "../upstream/event_outbox_pump.js";
import type {
  EventOutboxQuarantineInput,
  EventOutboxQuarantineResult,
} from "../upstream/event_outbox_quarantine.js";
import type { RunnerEventFrame } from "./frame_protocol.js";
import type { RunnerHostCallAppliedReceipt } from "./runner_host_state_store.js";
import type { RunnerPhaseObservation } from "./runner_phase_observation.js";
import type {
  RunnerParentStorageSnapshot,
} from "./runner_parent_storage_protocol.js";
import { RunnerParentStorageWorkerClient } from "./runner_parent_storage_worker_client.js";
import type { RunnerSqliteTransactionObserver } from "./runner_sqlite_connection.js";
import type { RunnerBootstrapRecord } from "./sqlite_event_outbox.js";
import type { RunnerLifecycleRecord } from "./sqlite_runner_lifecycle.js";

export interface RunnerParentOutboxOptions {
  onCheckpointAdvanced?: (acknowledgedThrough: number) => Promise<void>;
  phaseObservation?: RunnerPhaseObservation;
  transactionObserver?: RunnerSqliteTransactionObserver;
  workerFactory?: (workerData: Record<string, unknown>) => Worker;
}

/**
 * Parent-side facade over the storage worker. Only the bootstrap record and the
 * acknowledged cursor are cached here; every database access happens in the
 * worker that owns runner.sqlite and runner-host.sqlite.
 */
export class RunnerParentOutbox implements EventOutboxPumpStore {
  private bootstrap: RunnerBootstrapRecord | null = null;
  private acknowledgedThrough: number | null = null;

  private constructor(
    private readonly client: RunnerParentStorageWorkerClient,
    private readonly databasePath: string,
    private readonly sessionId: string,
    private readonly onCheckpointAdvanced?: (acknowledgedThrough: number) => Promise<void>,
  ) {}

  static async open(
    runnerDatabasePath: string,
    sessionId: string,
    options: RunnerParentOutboxOptions = {},
  ): Promise<RunnerParentOutbox> {
    return await RunnerParentOutbox.openWithMode(
      "normal",
      runnerDatabasePath,
      sessionId,
      options,
    );
  }

  static async openClosedTail(
    runnerDatabasePath: string,
    sessionId: string,
    options: RunnerParentOutboxOptions = {},
  ): Promise<RunnerParentOutbox> {
    return await RunnerParentOutbox.openWithMode(
      "closed_tail",
      runnerDatabasePath,
      sessionId,
      options,
    );
  }

  private static async openWithMode(
    mode: "normal" | "closed_tail",
    runnerDatabasePath: string,
    sessionId: string,
    options: RunnerParentOutboxOptions,
  ): Promise<RunnerParentOutbox> {
    const client = new RunnerParentStorageWorkerClient({
      databasePath: runnerDatabasePath,
      sessionId,
      ...(options.phaseObservation ? { phaseObservation: options.phaseObservation } : {}),
      ...(options.transactionObserver
        ? { transactionObserver: options.transactionObserver }
        : {}),
      ...(options.workerFactory ? { workerFactory: options.workerFactory } : {}),
    });
    let snapshot: RunnerParentStorageSnapshot;
    try {
      snapshot = await client.open({ databasePath: runnerDatabasePath, sessionId, mode });
    } catch (error) {
      await client.disposeAfterOpenFailure();
      throw error;
    }
    const outbox = new RunnerParentOutbox(
      client,
      runnerDatabasePath,
      sessionId,
      options.onCheckpointAdvanced,
    );
    outbox.applySnapshot(snapshot);
    return outbox;
  }

  get streamId(): string {
    if (!this.bootstrap) {
      throw new Error("runner bootstrap record required before event append");
    }
    return this.bootstrap.stream_id;
  }

  get ackedSeq(): number {
    if (!this.bootstrap) return 0;
    if (this.acknowledgedThrough === null) {
      throw new Error("runner parent ACK checkpoint is unavailable before bootstrap");
    }
    return this.acknowledgedThrough;
  }

  onAppend(_listener: () => void): () => void {
    // The child process owns appends and sends the content-free doorbell over IPC.
    return () => {};
  }

  async readBootstrap(): Promise<RunnerBootstrapRecord | null> {
    const result = await this.client.readBootstrap();
    this.applySnapshot(result.snapshot);
    return result.value;
  }

  async readBatch(maxEvents?: number): Promise<EventOutboxBatch | null> {
    const result = await this.client.readBatch(maxEvents);
    this.applySnapshot(result.snapshot);
    return result.value;
  }

  async acknowledge(streamId: string, acknowledgedThrough: number): Promise<void> {
    const snapshot = await this.client.acknowledge(streamId, acknowledgedThrough);
    this.applySnapshot(snapshot);
    await this.onCheckpointAdvanced?.(acknowledgedThrough);
  }

  async quarantineHead(
    input: EventOutboxQuarantineInput,
  ): Promise<EventOutboxQuarantineResult> {
    const result = await this.client.quarantineHead(input);
    this.applySnapshot(result.snapshot);
    await this.onCheckpointAdvanced?.(input.record.source_seq);
    return result.value;
  }

  async readRecord(sourceSeq: number): Promise<EventOutboxRecord | null> {
    return await this.client.readRecord(sourceSeq);
  }

  async readLifecycle(): Promise<RunnerLifecycleRecord | null> {
    return await this.client.readLifecycle({
      databasePath: this.databasePath,
      sessionId: this.sessionId,
    });
  }

  async readLatestPendingRecord(): Promise<EventOutboxRecord | null> {
    const result = await this.client.readLatestPendingRecord();
    this.applySnapshot(result.snapshot);
    return result.value;
  }

  async readPendingIpcFrames(): Promise<Array<{
    frame_seq: number;
    outbox_source_seq: number;
    frame: Extract<RunnerEventFrame, { kind: "engine_event" }>;
  }>> {
    return await this.client.readPendingIpcFrames();
  }

  async hasPendingDurableWork(): Promise<boolean> {
    const result = await this.client.hasPendingDurableWork();
    this.applySnapshot(result.snapshot);
    return result.value;
  }

  async readHostCallApplied(
    correlationId: string,
  ): Promise<RunnerHostCallAppliedReceipt | null> {
    return await this.client.readHostCallApplied(correlationId);
  }

  async recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): Promise<void> {
    await this.client.recordHostCallApplied(input);
  }

  async acknowledgeHostCall(correlationId: string): Promise<void> {
    await this.client.acknowledgeHostCall(correlationId);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  /** Worker-measured phase durations, kept apart from parent wait times. */
  workerPhaseDurationsMs(): Record<string, number> {
    return this.client.workerPhaseDurationsMs();
  }

  private applySnapshot(snapshot: RunnerParentStorageSnapshot | undefined): void {
    if (!snapshot) return;
    const bootstrap = snapshot.bootstrap;
    if (bootstrap) {
      if (this.bootstrap && this.bootstrap.stream_id !== bootstrap.stream_id) {
        throw new Error("runner parent ACK stream_id mismatch");
      }
      if (this.bootstrap && this.bootstrap.session_id !== bootstrap.session_id) {
        throw new Error("runner parent outbox session differs from durable bootstrap");
      }
      this.bootstrap = bootstrap;
    }
    if (snapshot.acknowledgedThrough !== null) {
      this.acknowledgedThrough = Math.max(
        this.acknowledgedThrough ?? 0,
        snapshot.acknowledgedThrough,
      );
    }
  }
}
