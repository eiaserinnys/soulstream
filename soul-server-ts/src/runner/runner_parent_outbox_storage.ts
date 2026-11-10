import { dirname } from "node:path";

import { compareInterventionPriority } from "../task/task_intervention_queue.js";
import type { EventOutboxBatch, EventOutboxRecord } from "../upstream/event_outbox.js";
import {
  appendEventOutboxQuarantine,
  type EventOutboxQuarantineInput,
  type EventOutboxQuarantineResult,
} from "../upstream/event_outbox_quarantine.js";
import type { RunnerEventFrame } from "./frame_protocol.js";
import {
  RunnerHostStateStore,
  runnerHostStatePath,
  type RunnerHostCallAppliedReceipt,
  type RunnerHostInterventionFallback,
} from "./runner_host_state_store.js";
import type { RunnerPhaseExecutor } from "./runner_phase_observation.js";
import type {
  RunnerParentStorageOperationMap,
  RunnerParentStorageSnapshot,
} from "./runner_parent_storage_protocol.js";
import type { RunnerSqliteTransactionObserver } from "./runner_sqlite_connection.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapRecord,
} from "./sqlite_event_outbox.js";

export interface RunnerParentOutboxStorageOptions {
  phaseExecutor?: RunnerPhaseExecutor;
  transactionObserver?: RunnerSqliteTransactionObserver;
}

/**
 * Owns the parent-side runner.sqlite readonly connection and the FULL
 * runner-host.sqlite connection. Constructed inside the storage worker only.
 */
export class RunnerParentOutboxStorage {
  private bootstrap: RunnerBootstrapRecord | null = null;
  private acknowledgedThrough: number | null = null;

  private constructor(
    private readonly runner: RunnerSqliteEventOutbox,
    private readonly host: RunnerHostStateStore,
    private readonly sessionId: string,
    private readonly phaseExecutor?: RunnerPhaseExecutor,
  ) {}

  static async open(
    input: RunnerParentStorageOperationMap["open"]["input"],
    options: RunnerParentOutboxStorageOptions = {},
  ): Promise<RunnerParentOutboxStorage> {
    const runnerOptions = options.phaseExecutor
      ? { phaseObservation: options.phaseExecutor, sessionId: input.sessionId }
      : undefined;
    const runner = input.mode === "closed_tail"
      ? await RunnerSqliteEventOutbox.openReadOnlyTail(input.databasePath, runnerOptions)
      : await RunnerSqliteEventOutbox.openReadOnly(input.databasePath, runnerOptions);
    let host: RunnerHostStateStore | undefined;
    try {
      host = RunnerHostStateStore.open(
        runnerHostStatePath(input.databasePath),
        options.phaseExecutor
          ? {
            phaseObservation: options.phaseExecutor,
            sessionId: input.sessionId,
            label: "runner host state open",
          }
          : undefined,
        {
          sessionId: input.sessionId,
          ...(options.transactionObserver
            ? { transactionObserver: options.transactionObserver }
            : {}),
        },
      );
      const storage = new RunnerParentOutboxStorage(
        runner,
        host,
        input.sessionId,
        options.phaseExecutor,
      );
      await storage.readBootstrap();
      return storage;
    } catch (error) {
      try {
        host?.close();
      } catch {
        // The open error is the original failure; both closes are still attempted.
      }
      runner.close();
      throw error;
    }
  }

  get streamId(): string {
    return this.runner.streamId;
  }

  snapshot(): RunnerParentStorageSnapshot {
    return {
      bootstrap: this.bootstrap,
      acknowledgedThrough: this.acknowledgedThrough,
    };
  }

  async readBootstrap(): Promise<RunnerBootstrapRecord | null> {
    const bootstrap = await this.readRunnerBootstrap();
    if (!bootstrap) return null;
    this.host.initializeEventCheckpoint({
      streamId: bootstrap.stream_id,
      sessionId: bootstrap.session_id,
      acknowledgedThrough: this.runner.ackedSeq,
    });
    this.requireAcknowledgedThrough();
    return bootstrap;
  }

  async readBatch(maxEvents?: number): Promise<EventOutboxBatch | null> {
    const acknowledgedThrough = await this.readAcknowledgedThrough();
    if (acknowledgedThrough === null) return null;
    return await this.runner.readBatchAfter(acknowledgedThrough, maxEvents);
  }

  async acknowledge(streamId: string, acknowledgedThrough: number): Promise<void> {
    if (streamId !== this.streamId) {
      throw new Error("runner parent ACK stream_id mismatch");
    }
    this.host.acknowledgeEvent({
      streamId,
      sessionId: this.sessionId,
      acknowledgedThrough,
      latestDurableSourceSeq: this.runner.latestDurableSourceSeq(),
    });
    this.acknowledgedThrough = Math.max(this.acknowledgedThrough ?? 0, acknowledgedThrough);
  }

  async quarantineHead(
    input: EventOutboxQuarantineInput,
  ): Promise<EventOutboxQuarantineResult> {
    const expectedHead = this.requireAcknowledgedThrough() + 1;
    if (input.record.source_seq !== expectedHead) {
      throw new Error("runner parent quarantine target is not the durable head");
    }
    const durable = await this.runner.readRecord(expectedHead);
    if (!durable || durable.payload_hash !== input.record.payload_hash) {
      throw new Error("runner parent quarantine target differs from durable head");
    }
    const result = await appendEventOutboxQuarantine(
      dirname(this.runner.databasePath),
      input,
    );
    await this.acknowledge(input.record.stream_id, expectedHead);
    return result;
  }

  async readRecord(sourceSeq: number): Promise<EventOutboxRecord | null> {
    return await this.runner.readRecord(sourceSeq);
  }

  async readLatestPendingRecord(): Promise<EventOutboxRecord | null> {
    const acknowledgedThrough = await this.readAcknowledgedThrough();
    if (acknowledgedThrough === null) return null;
    const read = async () => await this.runner.readLatestPendingRecordAfter(acknowledgedThrough);
    return this.phaseExecutor
      ? await this.phaseExecutor.runAsync("dbRead", {
        sessionId: this.sessionId,
        databasePath: this.runner.databasePath,
        label: "runner parent pending record",
      }, read)
      : await read();
  }

  async readPendingIpcFrames(): Promise<Array<{
    frame_seq: number;
    outbox_source_seq: number;
    frame: Extract<RunnerEventFrame, { kind: "engine_event" }>;
  }>> {
    return await this.runner.readPendingIpcFrames();
  }

  async readPendingInterventions(): Promise<Array<{
    interventionId: string;
    message: Record<string, unknown>;
  }>> {
    return (await this.inspectPendingInterventions()).interventions;
  }

  async inspectPendingInterventions(): Promise<{
    interventions: Array<{
      interventionId: string;
      message: Record<string, unknown>;
    }>;
    childInterventionIds: string[];
    shadowedFallbackIds: string[];
  }> {
    const child = await this.runner.readPendingInterventions();
    const merged = new Map(child.map((entry) => [entry.interventionId, entry]));
    const shadowedFallbackIds: string[] = [];
    for (const fallback of this.host.readPendingInterventionFallbacks(this.sessionId)) {
      // runner.sqlite is the first durable owner. A later host fallback with the
      // same deterministic identity is a recovery copy, not a second payload
      // authority, even if regenerated prose differs.
      if (merged.has(fallback.interventionId)) {
        shadowedFallbackIds.push(fallback.interventionId);
        continue;
      }
      merged.set(fallback.interventionId, {
        interventionId: fallback.interventionId,
        message: fallback.message,
      });
    }
    return {
      interventions: [...merged.values()].sort((left, right) =>
        compareInterventionPriority(left.message, right.message)),
      childInterventionIds: child.map((entry) => entry.interventionId),
      shadowedFallbackIds,
    };
  }

  readInterventionFallback(
    interventionId: string,
  ): RunnerHostInterventionFallback | null {
    return this.host.readInterventionFallback(this.sessionId, interventionId);
  }

  removeInterventionFallback(interventionId: string): void {
    this.host.removeInterventionFallback(this.sessionId, interventionId);
  }

  /**
   * host_acked=0 is CHECK-limited to engine_event, whose non-null outbox_source_seq has an outbox FK.
   * stageRunnerIntervention passes requireBootstrap(), so an empty ledger also proves an empty inbox.
   */
  async hasPendingDurableWork(): Promise<boolean> {
    const acknowledgedThrough = await this.readAcknowledgedThrough();
    if (acknowledgedThrough === null) return false;
    return await this.runner.hasPendingDurableWork(acknowledgedThrough);
  }

  readHostCallApplied(correlationId: string): RunnerHostCallAppliedReceipt | null {
    return this.host.readHostCallApplied(this.sessionId, correlationId);
  }

  recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): void {
    this.host.recordHostCallApplied({ sessionId: this.sessionId, ...input });
  }

  acknowledgeHostCall(correlationId: string): void {
    this.host.acknowledgeHostCall(this.sessionId, correlationId);
  }

  close(): void {
    let firstError: unknown;
    try {
      this.host.close();
    } catch (error) {
      firstError = error;
    }
    try {
      this.runner.close();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
    if (firstError !== undefined) throw firstError;
  }

  private async readAcknowledgedThrough(): Promise<number | null> {
    if (!(await this.readRunnerBootstrap())) return null;
    return this.requireAcknowledgedThrough();
  }

  private async readRunnerBootstrap(): Promise<RunnerBootstrapRecord | null> {
    const bootstrap = await this.runner.readBootstrap();
    if (bootstrap && bootstrap.session_id !== this.sessionId) {
      throw new Error("runner parent outbox session differs from durable bootstrap");
    }
    this.bootstrap = bootstrap;
    return bootstrap;
  }

  private requireAcknowledgedThrough(): number {
    const read = () => this.host.readAcknowledgedThrough(this.streamId, this.sessionId);
    const acknowledgedThrough = this.phaseExecutor
      ? this.phaseExecutor.runSync("dbRead", {
        sessionId: this.sessionId,
        databasePath: runnerHostStatePath(this.runner.databasePath),
        label: "runner parent host ACK",
      }, read)
      : read();
    if (acknowledgedThrough === null) {
      throw new Error("runner parent ACK checkpoint is unavailable before bootstrap");
    }
    this.acknowledgedThrough = acknowledgedThrough;
    return acknowledgedThrough;
  }
}
