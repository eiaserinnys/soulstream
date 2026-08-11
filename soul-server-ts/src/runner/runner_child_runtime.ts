import { writeFile } from "node:fs/promises";

import type { Logger } from "pino";

import {
  buildEventOutboxAppendInput,
  shouldPersistEvent,
} from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { EventOutboxSessionEffect } from "../upstream/event_outbox.js";
import {
  executionEndedControlFrame,
  engineEventFrame,
  hostFrameAppliedControlFrame,
  outboxAvailableControlFrame,
  runnerCommandResultFrame,
  type RunnerCommandFrame,
  type RunnerEventFrame,
  type RunnerFrame,
} from "./frame_protocol.js";
import { createRunnerChildEngine } from "./runner_child_engine_factory.js";
import { RunnerHostRequestClient } from "./runner_host_request_client.js";
import {
  runnerDroppedFrameLogContext,
  type RunnerDroppedFrame,
} from "./runner_ipc_connection.js";
import { InProcessRunnerCommandDispatcher } from "./runner_command_dispatcher.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import { RunnerSocketEndpoint } from "./runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
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
  private droppedFrameCount = 0;

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
    this.outbox = await RunnerSqliteEventOutbox.open(this.config.paths.databasePath);
    this.lifecycle = RunnerSqliteLifecycle.open(
      this.config.paths.databasePath,
      this.config.sessionId,
    );
    this.endpoint = new RunnerSocketEndpoint(
      this.config.paths.socketPath,
      async (frame) => await this.handleFrame(frame),
      (error) => this.logger.warn({ error }, "Runner host socket disconnected"),
      (drop) => this.logDroppedFrame(drop),
    );
    const host = new RunnerHostRequestClient(() => this.endpoint.currentConnection);
    this.dispatcher = new InProcessRunnerCommandDispatcher(
      this.deps.createEngine(this.config, host, this.logger),
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
        this.logger.warn({ error }, "Runner engine close failed during shutdown");
      });
      await this.endpoint?.close();
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
      return;
    }
    throw new Error(`Runner child received unsupported control frame: ${frame.kind}`);
  }

  private async handleCommand(command: RunnerCommandFrame): Promise<void> {
    const connection = this.endpoint.currentConnection;
    if (!connection) throw new Error("Runner command arrived without a host connection");
    const result = await this.dispatcher.dispatch(command);
    await connection.send(result);
    if (result.result.status !== "ok") return;
    if (command.kind === "execute") {
      this.activeCommandId = command.commandId;
      void this.drainExecution(command).catch((error) => {
        this.logger.error({ error }, "Runner execution drain failed");
      });
      return;
    }
    if (command.kind === "close") {
      const lifecycle = this.lifecycle.read();
      if (lifecycle) {
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
      if (this.activeCommandId === command.commandId) this.activeCommandId = undefined;
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
      await this.finishLifecycle(command.commandId, terminalError);
    } catch (error) {
      this.logger.error({ error }, "Runner terminal lifecycle record failed");
    }
    const ended = executionEndedControlFrame(command.commandId, terminalError);
    await this.sendRequired(ended).catch((error) => {
      this.logger.warn({ error }, "Runner execution end could not reach host");
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
    const effect = sessionIdEffect(event);
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
    await this.forwardBootstrappedEvent(frame, event, effect);
  }

  private async forwardBootstrappedEvent(
    frame: RunnerEventFrame,
    event: SSEEventPayload,
    effect: EventOutboxSessionEffect | undefined,
  ): Promise<void> {
    if (!shouldPersistEvent(event)) {
      await this.sendBestEffort(frame);
      this.recordProgress();
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
    );
    await this.sendBestEffort(outboxAvailableControlFrame(durable.source_seq));
    this.recordProgress();
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
      this.logger.warn({ error }, "Transient runner frame dropped during disconnect");
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

  private async finishLifecycle(
    commandId: string,
    terminalError: { code: string; message: string } | undefined,
  ): Promise<void> {
    if (!this.lifecycle.read()) return;
    this.lifecycle.finish(
      commandId,
      terminalError ? "failed" : "completed",
      new Date().toISOString(),
      terminalError ?? null,
    );
  }

  private requireActiveCommandId(): string {
    if (!this.activeCommandId) throw new Error("runner active command id unavailable");
    return this.activeCommandId;
  }
}

function createPreBootstrapFrameBuffer(): PreBootstrapFrameBuffer {
  return { frames: [], bytes: 0 };
}

export function buildDurableRunnerEvent(
  sessionId: string,
  event: SSEEventPayload,
  effect?: EventOutboxSessionEffect,
  metadata?: unknown,
): {
  appendInput: ReturnType<typeof buildEventOutboxAppendInput>;
  frame: ReturnType<typeof engineEventFrame>;
} {
  const appendInput = buildEventOutboxAppendInput(sessionId, event, effect);
  return {
    appendInput,
    frame: engineEventFrame(appendInput.payload, metadata),
  };
}

function sessionIdEffect(event: SSEEventPayload): EventOutboxSessionEffect | undefined {
  if ((event as { type?: unknown }).type !== "session") return undefined;
  const sessionId = (event as { session_id?: unknown }).session_id;
  return typeof sessionId === "string" && sessionId.length > 0
    ? { kind: "set_backend_session_id", backend_session_id: sessionId }
    : undefined;
}

export function requiresBackendSessionId(backend: RunnerChildConfig["backend"]): boolean {
  return backend === "claude" || backend === "codex";
}

export async function setRunnerOomScore(
  platform: NodeJS.Platform = process.platform,
  path = "/proc/self/oom_score_adj",
): Promise<void> {
  if (platform !== "linux") return;
  await writeFile(path, "500\n");
}

export function isSqliteFullError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === "SQLITE_FULL" || /database or disk is full/i.test(error.message);
}
