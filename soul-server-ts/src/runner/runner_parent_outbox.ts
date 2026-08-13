import { dirname } from "node:path";

import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import type { EventOutboxPumpStore } from "../upstream/event_outbox_pump.js";
import {
  appendEventOutboxQuarantine,
  type EventOutboxQuarantineInput,
  type EventOutboxQuarantineResult,
} from "../upstream/event_outbox_quarantine.js";
import type { RunnerEventFrame } from "./frame_protocol.js";
import {
  RunnerHostStateStore,
  runnerHostStatePath,
} from "./runner_host_state_store.js";
import {
  RunnerSqliteEventOutbox,
  type RunnerBootstrapRecord,
} from "./sqlite_event_outbox.js";

export class RunnerParentOutbox implements EventOutboxPumpStore {
  private constructor(
    private readonly runner: RunnerSqliteEventOutbox,
    private readonly host: RunnerHostStateStore,
    private readonly sessionId: string,
    private readonly onCheckpointAdvanced?: (acknowledgedThrough: number) => Promise<void>,
  ) {}

  static async open(
    runnerDatabasePath: string,
    sessionId: string,
    options: {
      onCheckpointAdvanced?: (acknowledgedThrough: number) => Promise<void>;
    } = {},
  ): Promise<RunnerParentOutbox> {
    const runner = await RunnerSqliteEventOutbox.openReadOnly(runnerDatabasePath, { sessionId });
    try {
      const host = RunnerHostStateStore.open(runnerHostStatePath(runnerDatabasePath));
      const outbox = new RunnerParentOutbox(
        runner,
        host,
        sessionId,
        options.onCheckpointAdvanced,
      );
      await outbox.readBootstrap();
      return outbox;
    } catch (error) {
      runner.close();
      throw error;
    }
  }

  get streamId(): string {
    return this.runner.streamId;
  }

  get ackedSeq(): number {
    return this.requireAcknowledgedThrough();
  }

  onAppend(_listener: () => void): () => void {
    // The child process owns appends and sends the content-free doorbell over IPC.
    return () => {};
  }

  async readBootstrap(): Promise<RunnerBootstrapRecord | null> {
    const bootstrap = await this.runner.readBootstrap();
    if (!bootstrap) return null;
    if (bootstrap.session_id !== this.sessionId) {
      throw new Error("runner parent outbox session differs from durable bootstrap");
    }
    this.host.initializeEventCheckpoint({
      streamId: bootstrap.stream_id,
      sessionId: bootstrap.session_id,
      acknowledgedThrough: this.runner.ackedSeq,
    });
    return bootstrap;
  }

  async readBatch(maxEvents?: number) {
    return await this.runner.readBatchAfter(
      this.requireAcknowledgedThrough(),
      maxEvents,
    );
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
    await this.onCheckpointAdvanced?.(acknowledgedThrough);
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
    return await this.runner.readLatestPendingRecordAfter(this.requireAcknowledgedThrough());
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
    return await this.runner.readPendingInterventions();
  }

  async hasPendingDurableWork(): Promise<boolean> {
    return await this.runner.hasPendingDurableWork(this.requireAcknowledgedThrough());
  }

  async readHostCallApplied(correlationId: string) {
    return this.host.readHostCallApplied(this.sessionId, correlationId);
  }

  async recordHostCallApplied(input: {
    correlationId: string;
    service: string;
    operation: string;
    createdAt: string;
  }): Promise<void> {
    this.host.recordHostCallApplied({ sessionId: this.sessionId, ...input });
  }

  async acknowledgeHostCall(correlationId: string): Promise<void> {
    this.host.acknowledgeHostCall(this.sessionId, correlationId);
  }

  close(): void {
    this.host.close();
    this.runner.close();
  }

  private requireAcknowledgedThrough(): number {
    const acknowledgedThrough = this.host.readAcknowledgedThrough(
      this.streamId,
      this.sessionId,
    );
    if (acknowledgedThrough === null) {
      throw new Error("runner parent ACK checkpoint is unavailable before bootstrap");
    }
    return acknowledgedThrough;
  }
}
