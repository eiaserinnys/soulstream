/**
 * Runner child turn state machine. This file intentionally keeps command,
 * drain, persistence, and terminal sequencing in one control path; splitting
 * those transitions would make the ordering contract implicit.
 */
import type { Logger } from "pino";

import { shouldPersistEvent } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { EventOutboxSessionEffect } from "../upstream/event_outbox.js";
import {
  executionEndedControlFrame,
  hostFrameAppliedControlFrame,
  invokeCommandFrame,
  outboxAvailableControlFrame,
  runnerCommandResultFrame,
  type RunnerCommandFrame,
  type RunnerEventFrame,
  type RunnerFrame,
} from "./frame_protocol.js";
import {
  buildDurableRunnerEvent,
  backendSessionRotationEffect,
  isSqliteFullError,
  requiresBackendSessionId,
  runnerLivenessIntervalMs,
  runnerToolLeaseTransition,
  sessionIdEffect,
  setRunnerOomScore,
} from "./runner_child_runtime_helpers.js";
import { createRunnerChildEngine } from "./runner_child_engine_factory.js";
import { RunnerHostRequestClient } from "./runner_host_request_client.js";
import {
  claimRunnerInterventionExecution,
  handleRunnerInterventionCommand,
} from "./runner_intervention_command.js";
import {
  runnerDroppedFrameLogContext,
  type RunnerDroppedFrame,
} from "./runner_frame_drop.js";
import { InProcessRunnerCommandDispatcher } from "./runner_command_dispatcher.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import { completeRunnerRegistrationIdentityFromChild } from
  "./runner_registration_identity.js";
import { RunnerSocketEndpoint } from "./runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import {
  readRunnerHostAcknowledgedThrough,
  runnerHostStatePath,
} from "./runner_host_state_store.js";
import { RunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";
import { RunnerWriterLock } from "./runner_writer_lock.js";

const REQUIRED_HOST_SEND_ATTEMPTS = 61;
const REQUIRED_HOST_SEND_RETRY_MS = 500;
const PRE_BOOTSTRAP_EVENT_LIMIT = 1_024;
const PRE_BOOTSTRAP_BYTE_LIMIT = 8 * 1024 * 1024;

interface PreBootstrapFrameBuffer {
  frames: RunnerEventFrame[];
  bytes: number;
}

export class RunnerChildRuntime {
  private endpoint!: RunnerSocketEndpoint;
  private outbox!: RunnerSqliteEventOutbox;
  private lifecycle!: RunnerSqliteLifecycle;
  private lock!: RunnerWriterLock;
  private dispatcher!: InProcessRunnerCommandDispatcher;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private closing = false;
  private activeCommandId: string | undefined;
  private livenessTimer: ReturnType<typeof setInterval> | undefined;
  private droppedFrameCount = 0;
  private pendingBackendSessionRolloverFrom: string | undefined;

  constructor(
    private readonly config: RunnerChildConfig,
    private readonly logger: Logger,
    private readonly deps: {
      createEngine: typeof createRunnerChildEngine;
    } = { createEngine: createRunnerChildEngine },
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async start(): Promise<void> {
    this.lock = await RunnerWriterLock.acquire(this.config.paths.lockPath);
    await completeRunnerRegistrationIdentityFromChild(
      this.config.paths.sessionDirectory,
      {
        sessionId: this.config.sessionId,
        codeSha: this.config.codeSha,
        releaseManifestId: this.config.releaseManifestId,
        runtimeEnvIdentity: this.config.runtimeEnvIdentity,
        pid: this.lock.owner.pid,
        startIdentity: this.lock.owner.startIdentity,
      },
    );
    this.outbox = await RunnerSqliteEventOutbox.open(this.config.paths.databasePath);
    this.lifecycle = RunnerSqliteLifecycle.open(
      this.config.paths.databasePath,
      this.config.sessionId,
      {
        onSummaryRenameFailure: (error, path, details) => {
          const context = { err: error, path, consecutiveFailures: details.consecutiveFailures };
          if (details.severity === "error") {
            this.logger.error(
              context,
              "Runner lifecycle summary rename failure persisted; durable SQLite state retained",
            );
          } else {
            this.logger.warn(
              context,
              "Runner lifecycle summary rename retries exhausted; durable SQLite state retained",
            );
          }
        },
        onSummaryRenameRecovery: (path, recoveredAfterFailures) => this.logger.info(
          { path, recoveredAfterFailures },
          "Runner lifecycle summary rename recovered",
        ),
      },
    );
    this.endpoint = new RunnerSocketEndpoint(
      this.config.paths.socketPath,
      async (frame) => await this.handleFrame(frame),
      (error) => this.logger.warn({ err: error }, "Runner host socket disconnected"),
      (drop) => this.logDroppedFrame(drop),
    );
    const host = new RunnerHostRequestClient(() => this.endpoint.currentConnection);
    this.dispatcher = new InProcessRunnerCommandDispatcher(
      this.deps.createEngine(this.config, host, this.logger),
      { onFrameDropped: (drop) => this.logDroppedFrame(drop) },
    );
    await setRunnerOomScore();
    await this.endpoint.listen();
  }

  private logDroppedFrame(drop: RunnerDroppedFrame): void {
    this.droppedFrameCount += 1;
    this.logger.error(
      runnerDroppedFrameLogContext(drop, this.droppedFrameCount),
      "Invalid observational runner frame dropped",
    );
  }

  async waitUntilClosed(): Promise<void> {
    await this.closedPromise;
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.dispatcher?.close().catch((error) => {
        this.logger.warn({ err: error }, "Runner engine close failed during shutdown");
      });
      await this.endpoint?.close();
      this.stopLiveness();
      this.lifecycle?.close();
      this.outbox?.close();
      await this.lock?.release();
    } finally {
      this.resolveClosed();
    }
  }

  private async handleFrame(frame: RunnerFrame): Promise<void> {
    if (frame.channel === "command") {
      await this.handleCommand(frame);
      return;
    }
    if (frame.channel !== "control") {
      throw new Error("Runner child received an event frame from host");
    }
    if (frame.kind === "host_frame_applied") {
      const bootstrap = await this.outbox.readBootstrap();
      if (bootstrap) {
        const hostAcknowledgedThrough = readRunnerHostAcknowledgedThrough(
          runnerHostStatePath(this.config.paths.databasePath),
          bootstrap.stream_id,
          bootstrap.session_id,
        );
        if (
          hostAcknowledgedThrough !== null
          && hostAcknowledgedThrough > this.outbox.ackedSeq
        ) {
          await this.outbox.acknowledge(bootstrap.stream_id, hostAcknowledgedThrough);
        }
      }
      await this.outbox.acknowledgeHostFrame(frame.frameSeq);
      this.recordProgress();
      return;
    }
    if (
      frame.kind === "response"
      || frame.kind === "input_response"
      || frame.kind === "tool_approval_response"
    ) {
      await this.dispatcher.sendControlFrame(frame);
      this.recordProgress();
      return;
    }
    throw new Error(`Runner child received unsupported control frame: ${frame.kind}`);
  }

  private async handleCommand(command: RunnerCommandFrame): Promise<void> {
    const connection = this.endpoint.currentConnection;
    if (!connection) throw new Error("Runner command arrived without a host connection");
    const intervention = await handleRunnerInterventionCommand(
      command,
      this.outbox,
      this.config.sessionId,
      async (input) => {
        const invoked = await this.dispatcher.dispatch(invokeCommandFrame(
          command.commandId,
          "intervene",
          [input],
        ));
        if (invoked.result.status !== "ok") {
          throw new Error(invoked.result.error.message);
        }
        return invoked.result.data;
      },
    );
    if (intervention) {
      await connection.send(intervention.result);
      if (intervention.eventSourceSeq !== null) {
        await this.sendBestEffort(outboxAvailableControlFrame(intervention.eventSourceSeq));
      }
      return;
    }
    const interventionClaimFailure = command.kind === "execute"
      ? await claimRunnerInterventionExecution(command, this.outbox)
      : null;
    if (interventionClaimFailure) {
      await connection.send(interventionClaimFailure);
      return;
    }
    const result = await this.dispatcher.dispatch(command);
    if (
      result.result.status !== "ok"
      && command.kind === "execute"
    ) {
      const interventionIds = command.params.runnerInterventionIds
        ?? (command.params.runnerInterventionId ? [command.params.runnerInterventionId] : []);
      if (interventionIds.length > 0) {
        await this.outbox.markInterventionsAmbiguous(interventionIds, command.commandId);
      }
    }
    await connection.send(result);
    if (result.result.status !== "ok") return;
    if (command.kind === "execute") {
      this.activeCommandId = command.commandId;
      this.startLiveness();
      void this.drainExecution(command).catch((error) => {
        this.logger.error({ err: error }, "Runner execution drain failed");
      });
      return;
    }
    if (command.kind === "close") {
      const lifecycle = this.lifecycle.read();
      if (lifecycle?.execution_state === "running") {
        this.lifecycle.finish(
          lifecycle.execution_command_id,
          "closed",
          new Date().toISOString(),
        );
      }
      queueMicrotask(() => { void this.shutdown(); });
    }
  }

  private async drainExecution(
    command: Extract<RunnerCommandFrame, { kind: "execute" }>,
  ): Promise<void> {
    const preBootstrap = createPreBootstrapFrameBuffer();
    try {
      await this.drainExecutionWithBuffer(command, preBootstrap);
    } finally {
      this.discardPreBootstrapFrames(preBootstrap, "execution_terminal");
      this.pendingBackendSessionRolloverFrom = undefined;
      if (this.activeCommandId === command.commandId) this.activeCommandId = undefined;
      this.stopLiveness();
    }
  }

  private async drainExecutionWithBuffer(
    command: Extract<RunnerCommandFrame, { kind: "execute" }>,
    preBootstrap: PreBootstrapFrameBuffer,
  ): Promise<void> {
    let terminalError: { code: string; message: string } | undefined;
    let storageFailure = false;
    try {
      await this.prepareExecution(command);
      for await (const frame of this.dispatcher.events(command.commandId)) {
        await this.forwardRunnerFrame(frame, preBootstrap);
      }
      if (requiresBackendSessionId(this.config.backend) && !(await this.outbox.readBootstrap())) {
        this.discardPreBootstrapFrames(preBootstrap, "backend_session_id_missing");
        throw new Error(
          `${this.config.backend} execution ended before publishing its backend session ID`,
        );
      }
    } catch (error) {
      await this.dispatcher.interrupt().catch(() => false);
      storageFailure = isSqliteFullError(error);
      terminalError = {
        code: storageFailure ? "runner_storage_full" : "execution_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      await this.finishLifecycle(command, terminalError);
    } catch (error) {
      this.logger.error({ err: error }, "Runner terminal lifecycle commit failed");
      storageFailure = true;
      terminalError = {
        code: "runner_terminal_commit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const ended = executionEndedControlFrame(command.commandId, terminalError);
    await this.sendRequired(ended).catch((error) => {
      this.logger.warn({ err: error }, "Runner execution end could not reach host");
    });
    if (storageFailure) queueMicrotask(() => { void this.shutdown(); });
  }

  private async forwardRunnerFrame(
    frame: RunnerEventFrame,
    preBootstrap: PreBootstrapFrameBuffer,
  ): Promise<void> {
    if (frame.kind === "run_state_snapshot") {
      await this.callHostSnapshot("persistRunState", frame.snapshot);
      this.recordProgress();
      return;
    }
    if (frame.kind === "session_items_snapshot") {
      await this.callHostSnapshot("persistSessionItems", frame.snapshot);
      this.recordProgress();
      return;
    }
    if (frame.kind === "request") {
      await this.sendRequired(frame);
      this.recordProgress();
      return;
    }
    const event = frame.payload as SSEEventPayload;
    this.recordEngineProgress(event);
    let effect = sessionIdEffect(event);
    let backendSessionRotation: {
      expectedBackendSessionId: string;
      backendSessionId: string;
    } | undefined;
    if (
      this.pendingBackendSessionRolloverFrom
      && effect?.kind === "set_backend_session_id"
    ) {
      backendSessionRotation = {
        expectedBackendSessionId: this.pendingBackendSessionRolloverFrom,
        backendSessionId: effect.backend_session_id,
      };
      effect = backendSessionRotationEffect(
        backendSessionRotation.expectedBackendSessionId,
        backendSessionRotation.backendSessionId,
      );
    }
    const backendSessionId = effect?.kind === "set_backend_session_id"
      ? effect.backend_session_id
      : null;
    const bootstrap = await this.outbox.readBootstrap();
    if (!bootstrap && requiresBackendSessionId(this.config.backend)) {
      if (backendSessionId === null) {
        const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
        if (preBootstrap.frames.length >= PRE_BOOTSTRAP_EVENT_LIMIT) {
          throw new Error(
            `${this.config.backend} exceeded ${PRE_BOOTSTRAP_EVENT_LIMIT} events before its backend session ID`,
          );
        }
        if (preBootstrap.bytes + frameBytes > PRE_BOOTSTRAP_BYTE_LIMIT) {
          throw new Error(
            `${this.config.backend} exceeded ${PRE_BOOTSTRAP_BYTE_LIMIT} bytes before its backend session ID`,
          );
        }
        preBootstrap.frames.push(frame);
        preBootstrap.bytes += frameBytes;
        return;
      }
      await this.ensureBootstrap(backendSessionId, this.requireActiveCommandId());
      await this.flushPreBootstrapFrames(preBootstrap);
    } else if (!bootstrap) {
      await this.ensureBootstrap(null, this.requireActiveCommandId());
    }
    await this.forwardBootstrappedEvent(
      frame,
      event,
      effect,
      backendSessionRotation,
    );
    if (backendSessionRotation) this.pendingBackendSessionRolloverFrom = undefined;
  }

  private async forwardBootstrappedEvent(
    frame: RunnerEventFrame,
    event: SSEEventPayload,
    effect: EventOutboxSessionEffect | undefined,
    backendSessionRotation?: {
      expectedBackendSessionId: string;
      backendSessionId: string;
    },
  ): Promise<void> {
    if (!shouldPersistEvent(event)) {
      await this.sendBestEffort(frame);
      return;
    }
    const durableEvent = buildDurableRunnerEvent(
      this.config.sessionId,
      event,
      effect,
      frame.metadata,
    );
    const durable = await this.outbox.appendEngineFrame(
      durableEvent.appendInput,
      durableEvent.frame,
      backendSessionRotation,
    );
    await this.sendBestEffort(outboxAvailableControlFrame(durable.source_seq));
  }

  private async flushPreBootstrapFrames(buffer: PreBootstrapFrameBuffer): Promise<void> {
    const pending = buffer.frames.splice(0);
    buffer.bytes = 0;
    for (const frame of pending) {
      const event = frame.payload as SSEEventPayload;
      await this.forwardBootstrappedEvent(frame, event, sessionIdEffect(event));
    }
  }

  private async prepareExecution(
    command: Extract<RunnerCommandFrame, { kind: "execute" }>,
  ): Promise<void> {
    const bootstrap = await this.outbox.readBootstrap();
    if (bootstrap) {
      const rolloverFrom = command.params.backendSessionRolloverFrom;
      if (rolloverFrom !== undefined) {
        if (this.config.backend !== "claude") {
          throw new Error("runner backend session rollover is Claude-only");
        }
        if (command.params.resumeSessionId !== undefined) {
          throw new Error("runner backend session rollover cannot also resume");
        }
        if (bootstrap.payload.backend_session_id !== rolloverFrom) {
          throw new Error("runner backend session rollover conflicts with durable bootstrap");
        }
        this.pendingBackendSessionRolloverFrom = rolloverFrom;
        this.beginLifecycle(command.commandId);
        return;
      }
      const resumeSessionId = command.params.resumeSessionId;
      if (
        resumeSessionId !== undefined
        && bootstrap.payload.backend_session_id !== resumeSessionId
      ) {
        throw new Error("runner execute resume session ID conflicts with durable bootstrap");
      }
      this.beginLifecycle(command.commandId);
      return;
    }
    if (command.params.backendSessionRolloverFrom !== undefined) {
      throw new Error("runner backend session rollover requires durable bootstrap");
    }
    if (command.params.resumeSessionId !== undefined) {
      await this.ensureBootstrap(command.params.resumeSessionId, command.commandId);
      return;
    }
    if (!requiresBackendSessionId(this.config.backend)) {
      await this.ensureBootstrap(null, command.commandId);
      return;
    }
    this.beginLifecycle(command.commandId);
  }

  private async ensureBootstrap(
    backendSessionId: string | null,
    commandId: string,
  ): Promise<void> {
    await this.outbox.initializeBootstrap({
      session_id: this.config.sessionId,
      created_at: new Date().toISOString(),
      resume: {
        schema_version: 1,
        backend_session_id: backendSessionId,
        cwd: this.config.agent.workspace_dir,
        codex_home: this.config.codexHome,
        rollout_root: this.config.rolloutRoot,
        code_sha: this.config.codeSha,
        snapshot_path: this.config.snapshotPath,
      },
    });
    // Force the pre-bootstrap execution lease, when present, into the durable
    // bootstrap row. A same-command fast path in beginLifecycle() would leave
    // the temporary row behind and split lifecycle ownership.
    this.lifecycle.begin({
      pid: process.pid,
      commandId,
      progressedAt: new Date().toISOString(),
    });
  }

  private beginLifecycle(commandId: string): void {
    const existing = this.lifecycle.read();
    if (!existing || existing.execution_command_id !== commandId) {
      this.lifecycle.begin({
        pid: process.pid,
        commandId,
        progressedAt: new Date().toISOString(),
      });
    }
  }

  private discardPreBootstrapFrames(
    buffer: PreBootstrapFrameBuffer,
    reason: string,
  ): void {
    if (buffer.frames.length > 0) {
      this.logger.warn({
        reason,
        frameCount: buffer.frames.length,
        byteCount: buffer.bytes,
      }, "Discarding pre-bootstrap runner frames");
    }
    buffer.frames.length = 0;
    buffer.bytes = 0;
  }

  private async callHostSnapshot(operation: string, snapshot: unknown): Promise<void> {
    const host = new RunnerHostRequestClient(() => this.endpoint.currentConnection);
    await host.call("snapshot", operation, [this.config.sessionId, snapshot], {
      timeoutMs: 30_000,
      attempts: 61,
      retryDelayMs: 500,
    });
  }

  private async sendBestEffort(frame: RunnerFrame): Promise<void> {
    const connection = this.endpoint.currentConnection;
    if (!connection) return;
    await connection.send(frame).catch((error) => {
      this.logger.warn({ err: error }, "Transient runner frame dropped during disconnect");
    });
  }

  private async sendRequired(frame: RunnerFrame): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= REQUIRED_HOST_SEND_ATTEMPTS; attempt += 1) {
      const connection = this.endpoint.currentConnection;
      if (connection) {
        try {
          await connection.send(frame);
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      } else {
        lastError = new Error("Runner host connection unavailable");
      }
      if (attempt < REQUIRED_HOST_SEND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, REQUIRED_HOST_SEND_RETRY_MS));
      }
    }
    throw new Error("Required runner frame could not reach host", { cause: lastError });
  }

  private recordProgress(): void {
    if (!this.activeCommandId || !this.lifecycle.read()) return;
    this.lifecycle.progress(this.activeCommandId, new Date().toISOString());
  }

  private recordEngineProgress(event: SSEEventPayload): void {
    if (!this.activeCommandId || !this.lifecycle.read()) return;
    const progressedAt = new Date().toISOString();
    const transition = runnerToolLeaseTransition(event);
    if (transition?.kind === "start") {
      this.lifecycle.toolStarted(this.activeCommandId, transition.toolUseId, progressedAt);
      return;
    }
    if (transition?.kind === "finish") {
      this.lifecycle.toolFinished(this.activeCommandId, transition.toolUseId, progressedAt);
      return;
    }
    this.lifecycle.progress(this.activeCommandId, progressedAt);
  }

  private recordLiveness(): void {
    if (!this.activeCommandId || !this.lifecycle.read()) return;
    this.lifecycle.liveness(this.activeCommandId, new Date().toISOString());
  }

  private startLiveness(): void {
    this.stopLiveness();
    const leaseTimeoutMs = this.config.runnerLeaseTimeoutMs;
    if (leaseTimeoutMs === undefined) return;
    const intervalMs = runnerLivenessIntervalMs(leaseTimeoutMs);
    this.livenessTimer = setInterval(() => {
      try {
        this.recordLiveness();
      } catch (error) {
        this.logger.error({ err: error }, "Runner lifecycle liveness update failed");
      }
    }, intervalMs);
    this.livenessTimer.unref?.();
  }

  private stopLiveness(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
  }

  private async finishLifecycle(
    command: Extract<RunnerCommandFrame, { kind: "execute" }>,
    terminalError: { code: string; message: string } | undefined,
  ): Promise<void> {
    await this.outbox.finishExecution({
      commandId: command.commandId,
      ...(command.params.runnerInterventionIds
        ? { interventionIds: command.params.runnerInterventionIds }
        : {}),
      ...(command.params.runnerInterventionId
        ? { interventionId: command.params.runnerInterventionId }
        : {}),
      state: terminalError ? "failed" : "completed",
      progressedAt: new Date().toISOString(),
      terminalError: terminalError ?? null,
    });
    this.lifecycle.syncSummary();
  }

  private requireActiveCommandId(): string {
    if (!this.activeCommandId) throw new Error("runner active command id unavailable");
    return this.activeCommandId;
  }
}

function createPreBootstrapFrameBuffer(): PreBootstrapFrameBuffer {
  return { frames: [], bytes: 0 };
}
