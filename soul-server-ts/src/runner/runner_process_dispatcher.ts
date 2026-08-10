import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  EngineExecuteParams,
} from "../engine/protocol.js";
import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import { EventOutboxPump } from "../upstream/event_outbox_pump.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import {
  closeCommandFrame,
  executeCommandFrame,
  executionStatusCommandFrame,
  hostFrameAppliedControlFrame,
  interruptCommandFrame,
  invokeCommandFrame,
  prepareSessionCommandFrame,
  runnerControlResponseFrame,
  type RunnerCommandFrame,
  type RunnerCommandResultFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
  type RunnerFrame,
} from "./frame_protocol.js";
import type { RunnerCommandDispatcher } from "./runner_command_dispatcher.js";
import { RunnerHostCallIdempotency } from "./runner_host_call_idempotency.js";
import type { RunnerIpcConnection } from "./runner_ipc_connection.js";
import {
  RunnerProcessSpawner,
  type SpawnRunnerProcessInput,
} from "./runner_process_spawn.js";
import { runnerProcessPaths } from "./runner_process_paths.js";
import { ProcessFrameStream } from "./runner_process_frame_stream.js";
import { connectRunnerSocket } from "./runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import { RunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";

const COMMAND_TIMEOUT_MS = 30_000;
const RECENT_HOST_RESPONSE_LIMIT = 128;

interface RequestLifetime {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

export interface RunnerHostCall {
  correlationId: string;
  service: "session_store" | "claude_runtime" | "detached_event" | "snapshot";
  operation: string;
  args: unknown[];
}

export interface RunnerProcessDispatcherOptions {
  spawn: SpawnRunnerProcessInput;
  spawner?: Pick<RunnerProcessSpawner, "spawn"> & Partial<Pick<RunnerProcessSpawner, "adopt">>;
  adoptExisting?: boolean;
  offlineExisting?: boolean;
  pumpMux: EventOutboxPumpMux;
  logger: Logger;
  handleHostCall(call: RunnerHostCall): Promise<unknown>;
}

export class RunnerProcessDispatcher implements RunnerCommandDispatcher {
  private readonly ready: Promise<void>;
  private connection: RunnerIpcConnection | undefined;
  private socketPath: string | undefined;
  private outbox!: RunnerSqliteEventOutbox;
  private lifecycle!: RunnerSqliteLifecycle;
  private pump: EventOutboxPump | undefined;
  private unregisterPump: (() => void) | undefined;
  private connecting: Promise<RunnerIpcConnection> | undefined;
  private activeExecuteCommandId: string | undefined;
  private activeStream: ProcessFrameStream | undefined;
  private latestPendingRecord: EventOutboxRecord | undefined;
  private readonly requestLifetimes = new Map<string, RequestLifetime>();
  private readonly recentHostResponses = new Map<string, RunnerControlFrame>();
  private hostCallIdempotency!: RunnerHostCallIdempotency;
  private closed = false;

  constructor(private readonly options: RunnerProcessDispatcherOptions) {
    this.ready = this.initialize();
  }

  async dispatch(frame: unknown): Promise<RunnerCommandResultFrame> {
    await this.ready;
    const command = frame as RunnerCommandFrame;
    const connection = await this.ensureConnection();
    const response = await connection.request(command, { timeoutMs: COMMAND_TIMEOUT_MS });
    if (response.kind !== "command_result") {
      throw new Error("Runner command received a non-command result");
    }
    return response;
  }

  executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const commandId = `execute:${randomUUID()}`;
    const stream = new ProcessFrameStream(async (frameSeq) => {
      await this.outbox.acknowledgeHostFrame(frameSeq);
      await this.sendBestEffort(hostFrameAppliedControlFrame(frameSeq));
    });
    this.activeExecuteCommandId = commandId;
    this.activeStream = stream;
    void this.startExecute(commandId, params, stream);
    return stream;
  }

  recoverFrames(commandId?: string): AsyncIterable<RunnerEventFrame> {
    const stream = new ProcessFrameStream(async (frameSeq) => {
      await this.outbox.acknowledgeHostFrame(frameSeq);
      await this.sendBestEffort(hostFrameAppliedControlFrame(frameSeq));
    });
    this.activeExecuteCommandId = commandId;
    this.activeStream = stream;
    void this.startRecovery(commandId, stream);
    return stream;
  }

  async prepareSession(agentSessionId: string): Promise<void> {
    assertCommandAccepted(await this.dispatch(
      prepareSessionCommandFrame(`prepare:${agentSessionId}`, agentSessionId),
    ));
  }

  async interrupt(): Promise<boolean> {
    this.abortRequestLifetimes(new Error("Runner interrupted"));
    const result = await this.dispatch(interruptCommandFrame(`interrupt:${randomUUID()}`));
    assertCommandAccepted(result);
    return result.result.status === "ok"
      && isRecord(result.result.data)
      && result.result.data.interrupted === true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortRequestLifetimes(new Error("Runner closed"));
    if (this.options.offlineExisting) {
      this.releaseHostResources();
      return;
    }
    try {
      assertCommandAccepted(await this.dispatch(closeCommandFrame(`close:${randomUUID()}`)));
    } finally {
      this.releaseHostResources();
    }
  }

  async detachHost(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortRequestLifetimes(new Error("Runner host detached"));
    this.releaseHostResources();
  }

  async sendControlFrame(frame: RunnerControlFrame): Promise<boolean> {
    if (frame.kind === "response") this.finishRequestLifetime(frame.correlationId);
    await (await this.ensureConnection()).send(frame);
    return true;
  }

  requestContext(correlationId: string): { signal: AbortSignal; timeoutMs: number } | undefined {
    const lifetime = this.requestLifetimes.get(correlationId);
    return lifetime
      ? { signal: lifetime.controller.signal, timeoutMs: lifetime.timeoutMs }
      : undefined;
  }

  async waitForSessionAck(): Promise<number | null> {
    const record = this.latestPendingRecord;
    if (!record || !this.pump) return null;
    const eventId = await this.pump.waitForAcknowledgement(record);
    if (this.latestPendingRecord?.source_seq === record.source_seq) {
      this.latestPendingRecord = undefined;
    }
    return eventId;
  }

  async invoke(capability: string, args: unknown[]): Promise<unknown> {
    const result = await this.dispatch(invokeCommandFrame(
      `invoke:${capability}:${randomUUID()}`,
      capability,
      args,
    ));
    assertCommandAccepted(result);
    return result.result.status === "ok" ? result.result.data : undefined;
  }

  private async initialize(): Promise<void> {
    if (this.options.offlineExisting) {
      const paths = runnerProcessPaths(
        this.options.spawn.stateDirectory,
        this.options.spawn.sessionId,
      );
      this.socketPath = paths.socketPath;
      this.outbox = await RunnerSqliteEventOutbox.open(paths.databasePath);
      this.hostCallIdempotency = new RunnerHostCallIdempotency(this.outbox);
      this.lifecycle = RunnerSqliteLifecycle.open(paths.databasePath);
      return;
    }
    const spawner = this.options.spawner ?? new RunnerProcessSpawner();
    const spawned = this.options.adoptExisting
      ? await this.adoptExisting(spawner)
      : await spawner.spawn(this.options.spawn);
    this.socketPath = spawned.paths.socketPath;
    this.outbox = await RunnerSqliteEventOutbox.open(spawned.paths.databasePath);
    this.hostCallIdempotency = new RunnerHostCallIdempotency(this.outbox);
    this.lifecycle = RunnerSqliteLifecycle.open(spawned.paths.databasePath);
    await this.connect(spawned.paths.socketPath);
  }

  private async adoptExisting(
    spawner: RunnerProcessDispatcherOptions["spawner"] | RunnerProcessSpawner,
  ) {
    if (!spawner?.adopt) throw new Error("runner adopter unavailable");
    const adopted = await spawner.adopt({
      stateDirectory: this.options.spawn.stateDirectory,
      sessionId: this.options.spawn.sessionId,
    });
    if (!adopted) {
      throw new Error(`registered runner is not alive: ${this.options.spawn.sessionId}`);
    }
    return adopted;
  }

  private async startRecovery(
    requestedCommandId: string | undefined,
    stream: ProcessFrameStream,
  ): Promise<void> {
    let commandId = requestedCommandId;
    try {
      await this.ready;
      if (!commandId) {
        commandId = readActiveExecutionCommandId(assertCommandAccepted(
          await this.dispatch(executionStatusCommandFrame(`status:${randomUUID()}`)),
        ));
        this.activeExecuteCommandId = commandId;
      }
      const lifecycle = this.lifecycle.read();
      if (lifecycle && lifecycle.execution_command_id !== commandId) {
        throw new Error(`runner recovery command unavailable: ${commandId}`);
      }
      await this.replayPendingFrames();
      if (!lifecycle) return;
      if (lifecycle.execution_state === "running") return;
      if (lifecycle.execution_state === "completed" || lifecycle.execution_state === "closed") {
        stream.finish();
      } else {
        stream.fail(new Error(
          lifecycle.terminal_error?.message ?? `runner ${lifecycle.execution_state}`,
        ));
      }
      this.clearActiveExecution(commandId);
    } catch (error) {
      stream.fail(asError(error));
      if (commandId) this.clearActiveExecution(commandId);
    }
  }

  private async startExecute(
    commandId: string,
    params: EngineExecuteParams,
    stream: ProcessFrameStream,
  ): Promise<void> {
    try {
      assertCommandAccepted(await this.dispatch(executeCommandFrame(commandId, params)));
      await this.replayPendingFrames();
    } catch (error) {
      stream.fail(asError(error));
      this.clearActiveExecution(commandId);
    }
  }

  private async connect(socketPath: string): Promise<RunnerIpcConnection> {
    const connection = await connectRunnerSocket(socketPath, {
      timeoutMs: 500,
      attempts: 40,
      retryDelayMs: 50,
    });
    this.attachConnection(connection, socketPath);
    return connection;
  }

  private attachConnection(connection: RunnerIpcConnection, socketPath: string): void {
    this.connection?.close();
    this.connection = connection;
    connection.onFrame(async (frame) => await this.handleFrame(frame));
    connection.onFailure((error) => {
      if (this.connection !== connection || this.closed) return;
      this.connection = undefined;
      this.options.logger.warn({ error }, "Runner IPC disconnected; reconnecting");
      void this.reconnect(socketPath);
    });
    void this.replayPendingFrames().catch((error) => {
      this.options.logger.error({ error }, "Runner IPC replay failed");
      this.activeStream?.fail(asError(error));
    });
  }

  private async reconnect(socketPath: string): Promise<void> {
    try {
      await this.connect(socketPath);
    } catch (error) {
      this.activeStream?.fail(asError(error));
    }
  }

  private async ensureConnection(): Promise<RunnerIpcConnection> {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = this.ready.then(async () => {
        if (this.connection) return this.connection;
        if (!this.socketPath) throw new Error("Runner socket path unavailable");
        return await this.connect(this.socketPath);
      }).finally(() => {
        this.connecting = undefined;
      });
    }
    return await this.connecting;
  }

  private async handleFrame(frame: RunnerFrame): Promise<void> {
    if (frame.channel === "event") {
      if (frame.kind === "request" && frame.request.kind === "host_call") {
        await this.handleHostRequest(frame);
        return;
      }
      if (frame.kind === "request") this.startRequestLifetime(frame);
      this.activeStream?.push(frame);
      return;
    }
    if (frame.channel !== "control") {
      throw new Error("Runner host received a command frame from child");
    }
    if (frame.kind === "outbox_available") {
      await this.ensurePump();
      this.pump?.notifyAvailable();
      await this.replayPendingFrames();
      return;
    }
    if (frame.kind === "host_call_applied") {
      await this.hostCallIdempotency.acknowledge(frame.correlationId);
      this.recentHostResponses.delete(frame.correlationId);
      return;
    }
    if (frame.kind === "execution_ended") {
      await this.replayPendingFrames();
      if (frame.error) this.activeStream?.fail(new Error(frame.error.message));
      else this.activeStream?.finish();
      this.clearActiveExecution(frame.commandId);
      return;
    }
  }

  private async handleHostRequest(
    frame: Extract<RunnerEventFrame, { kind: "request" }>,
  ): Promise<void> {
    if (frame.request.kind !== "host_call") return;
    const cached = this.recentHostResponses.get(frame.correlationId);
    if (cached) {
      await this.sendBestEffort(cached);
      return;
    }
    let response: RunnerControlFrame;
    try {
      const call = {
        correlationId: frame.correlationId,
        service: frame.request.service,
        operation: frame.request.operation,
        args: frame.request.args,
      } satisfies RunnerHostCall;
      const { data } = await this.hostCallIdempotency.execute(
        call,
        async (idempotencyKey) => {
          if (idempotencyKey !== call.correlationId) {
            throw new Error("runner host-call idempotency key mismatch");
          }
          return await this.options.handleHostCall(call);
        },
      );
      response = runnerControlResponseFrame(frame.correlationId, {
        status: "ok",
        ...(data !== undefined ? { data } : {}),
      });
    } catch (error) {
      response = runnerControlResponseFrame(frame.correlationId, {
        status: "error",
        error: { code: "host_call_failed", message: asError(error).message },
      });
    }
    this.recentHostResponses.set(frame.correlationId, response);
    while (this.recentHostResponses.size > RECENT_HOST_RESPONSE_LIMIT) {
      const oldest = this.recentHostResponses.keys().next().value;
      if (oldest === undefined) break;
      this.recentHostResponses.delete(oldest);
    }
    await this.sendBestEffort(response);
  }

  private async ensurePump(): Promise<void> {
    if (this.pump) return;
    const bootstrap = await this.outbox.readBootstrap();
    if (!bootstrap) return;
    this.pump = new EventOutboxPump(this.outbox, (error) => {
      this.options.logger.error({ error }, "Runner event outbox pump failed");
    });
    this.unregisterPump = this.options.pumpMux.register(this.pump);
  }

  private async replayPendingFrames(): Promise<void> {
    if (!this.outbox || !this.activeStream) return;
    await this.ensurePump();
    const pending = await this.outbox.readPendingIpcFrames();
    for (const entry of pending) {
      if (!this.activeStream.push(entry.frame, entry.frame_seq)) continue;
      const record = await this.outbox.readRecord(entry.outbox_source_seq);
      if (record) this.latestPendingRecord = record;
    }
  }

  private startRequestLifetime(frame: Extract<RunnerEventFrame, { kind: "request" }>): void {
    this.finishRequestLifetime(frame.correlationId);
    const controller = new AbortController();
    const timeoutMs = frame.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const lifetime = this.requestLifetimes.get(frame.correlationId);
      if (!lifetime || lifetime.controller !== controller) return;
      this.requestLifetimes.delete(frame.correlationId);
      controller.abort(new Error(`Runner request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    this.requestLifetimes.set(frame.correlationId, { controller, timer, timeoutMs });
  }

  private finishRequestLifetime(correlationId: string): void {
    const lifetime = this.requestLifetimes.get(correlationId);
    if (!lifetime) return;
    clearTimeout(lifetime.timer);
    this.requestLifetimes.delete(correlationId);
  }

  private abortRequestLifetimes(reason: Error): void {
    for (const lifetime of this.requestLifetimes.values()) {
      clearTimeout(lifetime.timer);
      lifetime.controller.abort(reason);
    }
    this.requestLifetimes.clear();
  }

  private clearActiveExecution(commandId: string): void {
    if (this.activeExecuteCommandId !== commandId) return;
    this.activeExecuteCommandId = undefined;
    this.activeStream = undefined;
    this.abortRequestLifetimes(new Error("Runner execution ended"));
  }

  private async sendBestEffort(frame: RunnerFrame): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.send(frame).catch((error) => {
      this.options.logger.warn({ error }, "Runner host response dropped during reconnect");
    });
  }

  private releaseHostResources(): void {
    this.connection?.close();
    this.connection = undefined;
    this.unregisterPump?.();
    this.unregisterPump = undefined;
    this.lifecycle?.close();
    this.outbox?.close();
  }
}

function assertCommandAccepted(frame: RunnerCommandResultFrame): RunnerCommandResultFrame {
  if (frame.result.status === "ok") return frame;
  throw new Error(
    `Runner command ${frame.commandId} failed (${frame.result.error.code}): ${frame.result.error.message}`,
  );
}

function readActiveExecutionCommandId(frame: RunnerCommandResultFrame): string {
  if (
    frame.result.status === "ok"
    && isRecord(frame.result.data)
    && typeof frame.result.data.executionCommandId === "string"
    && frame.result.data.executionCommandId.length > 0
  ) {
    return frame.result.data.executionCommandId;
  }
  throw new Error("registered runner has no active execution command");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
