/**
 * Parent-side runner state machine. Connection, frame consumption, host calls,
 * and pump ordering intentionally remain in one control path so persistence
 * acknowledgements cannot be reordered across shallow wrapper modules.
 */
import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  EngineExecuteParams,
  EngineInterventionResult,
} from "../engine/protocol.js";
import type { EventOutboxRecord } from "../upstream/event_outbox.js";
import { EventOutboxPump } from "../upstream/event_outbox_pump.js";
import type { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import type { NodeStallMonitor } from "../runtime/node_stall_monitor.js";
import {
  applyInterventionCommandFrame,
  closeCommandFrame,
  discardInterventionCommandFrame,
  executeCommandFrame,
  executionStatusCommandFrame,
  hostFrameAppliedControlFrame,
  interruptCommandFrame,
  invokeCommandFrame,
  prepareSessionCommandFrame,
  runnerControlResponseFrame,
  stageInterventionCommandFrame,
  type RunnerCommandFrame,
  type RunnerCommandResultFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
  type RunnerFrame,
} from "./frame_protocol.js";
import type { RunnerCommandDispatcher } from "./runner_command_dispatcher.js";
import type {
  RunnerInterventionStageInput,
  RunnerInterventionStageResult,
  RunnerInterventionApplyInput,
  RunnerPendingIntervention,
} from "./runner_command_dispatcher.js";
import { normalizeRunnerInterventionResult } from "./runner_intervention_result.js";
import {
  runnerInterventionApplyCommandId,
  runnerInterventionDiscardCommandId,
} from "./runner_intervention_identity.js";
import { RunnerHostCallIdempotency } from "./runner_host_call_idempotency.js";
import { releaseRunnerHostResources } from "./runner_host_resource_cleanup.js";
import { RunnerParentOutbox } from "./runner_parent_outbox.js";
import {
  type RunnerIpcConnection,
} from "./runner_ipc_connection.js";
import {
  runnerDroppedFrameLogContext,
  type RunnerDroppedFrame,
} from "./runner_frame_drop.js";
import {
  RunnerProcessSpawner,
  type SpawnRunnerProcessInput,
} from "./runner_process_spawn.js";
import { runnerProcessPaths } from "./runner_process_paths.js";
import { ProcessFrameStream } from "./runner_process_frame_stream.js";
import { connectRunnerSocket } from "./runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import { readRunnerSqliteLifecycle } from "./sqlite_runner_lifecycle.js";
import { RunnerWriterLock } from "./runner_writer_lock.js";

const COMMAND_TIMEOUT_MS = 30_000;
const RECENT_HOST_RESPONSE_LIMIT = 128;
const RUNNER_SOCKET_CONNECT_DEADLINE_MS = 10_000;
const RUNNER_SOCKET_CONNECT_RETRY_MS = 50;
const DEFAULT_RECONNECT_POLICY: RunnerIpcReconnectPolicy = {
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  maxAttempts: 6,
  stableConnectionMs: 30_000,
};

interface RunnerIpcReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  stableConnectionMs: number;
}

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
  spawn: SpawnRunnerProcessInput | Promise<SpawnRunnerProcessInput>;
  spawner?: Pick<RunnerProcessSpawner, "spawn"> & Partial<Pick<RunnerProcessSpawner, "adopt">>;
  adoptExisting?: boolean;
  offlineExisting?: boolean;
  pumpMux: EventOutboxPumpMux;
  logger: Logger;
  reconnectPolicy?: RunnerIpcReconnectPolicy;
  reconnectSleep?(delayMs: number): Promise<void>;
  now?: () => number;
  nodeStallMonitor?: Pick<
    NodeStallMonitor,
    "beginRunnerOperation" | "sqliteTransactionObserver"
  >;
  handleHostCall(call: RunnerHostCall): Promise<unknown>;
}

export class RunnerProcessDispatcher implements RunnerCommandDispatcher {
  private droppedFrameCount = 0;
  private readonly ready: Promise<void>;
  private spawnInput!: SpawnRunnerProcessInput;
  private connection: RunnerIpcConnection | undefined;
  private socketPath: string | undefined;
  private outbox!: RunnerParentOutbox;
  private stoppedRunnerWriter: RunnerSqliteEventOutbox | undefined;
  private stoppedRunnerWriterLock: RunnerWriterLock | undefined;
  private runnerDatabasePath!: string;
  private pump: EventOutboxPump | undefined;
  private pumpInitialization: Promise<void> | undefined;
  private unregisterPump: (() => void) | undefined;
  private connecting: Promise<RunnerIpcConnection> | undefined;
  private reconnectInFlight: Promise<void> | undefined;
  private reconnectRequested = false;
  private reconnectAttempts = 0;
  private reconnectCause: Error | undefined;
  private reconnectExhaustedError: Error | undefined;
  private activeExecuteCommandId: string | undefined;
  private activeStream: ProcessFrameStream | undefined;
  private latestPendingRecord: EventOutboxRecord | undefined;
  private latestConsumedFrameSeq: number | undefined;
  private readonly requestLifetimes = new Map<string, RequestLifetime>();
  private readonly recentHostResponses = new Map<string, RunnerControlFrame>();
  private hostCallIdempotency!: RunnerHostCallIdempotency;
  private finishActiveRunnerObservation: (() => void) | undefined;
  private closed = false;
  private readonly reconnectPolicy: RunnerIpcReconnectPolicy;

  constructor(private readonly options: RunnerProcessDispatcherOptions) {
    this.reconnectPolicy = validateReconnectPolicy(
      options.reconnectPolicy ?? DEFAULT_RECONNECT_POLICY,
    );
    this.ready = this.initialize();
  }

  async dispatch(frame: unknown): Promise<RunnerCommandResultFrame> {
    await this.ready;
    const command = frame as RunnerCommandFrame;
    const finishObservation = this.options.nodeStallMonitor?.beginRunnerOperation({
      sessionId: this.spawnInput.sessionId,
      commandId: command.commandId,
      operation: `command:${command.kind}`,
    });
    try {
      const connection = await this.ensureConnection();
      const response = await connection.request(command, { timeoutMs: COMMAND_TIMEOUT_MS });
      if (response.kind !== "command_result") {
        throw new Error("Runner command received a non-command result");
      }
      return response;
    } finally {
      finishObservation?.();
    }
  }

  executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const commandId = `execute:${randomUUID()}`;
    const stream = new ProcessFrameStream(async (frameSeq) => {
      await this.acknowledgeConsumedFrame(frameSeq);
    });
    this.activeExecuteCommandId = commandId;
    this.activeStream = stream;
    void this.startExecute(commandId, params, stream);
    return stream;
  }

  recoverFrames(commandId?: string): AsyncIterable<RunnerEventFrame> {
    const stream = new ProcessFrameStream(async (frameSeq) => {
      await this.acknowledgeConsumedFrame(frameSeq);
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
      await this.releaseHostResources();
      return;
    }
    try {
      assertCommandAccepted(await this.dispatch(closeCommandFrame(`close:${randomUUID()}`)));
    } finally {
      await this.releaseHostResources();
    }
  }

  async detachHost(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortRequestLifetimes(new Error("Runner host detached"));
    await this.releaseHostResources();
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

  async stageIntervention(
    input: RunnerInterventionStageInput,
  ): Promise<RunnerInterventionStageResult> {
    try {
      const staged = await this.stageInterventionInChild(input);
      // queued=true is independently replayable from runner.sqlite. A receipt
      // fence (queued=false) must remain host-durable until apply is accepted.
      if (input.queued) this.outbox.removeInterventionFallback(input.interventionId);
      return { ...staged, durability: "runner" };
    } catch (error) {
      await this.ready;
      const fallback = this.outbox.stageInterventionFallback(input);
      this.options.logger.info(
        {
          err: error,
          sessionId: this.spawnInput.sessionId,
          interventionId: input.interventionId,
          queued: input.queued,
          durability: "host_sqlite",
        },
        "Runner intervention staged in durable host fallback after child IPC failure",
      );
      return {
        eventSourceSeq: null,
        queuePosition: fallback.queuePosition,
        durability: "host_fallback",
      };
    }
  }

  private async stageInterventionInChild(
    input: RunnerInterventionStageInput,
  ): Promise<RunnerInterventionStageResult> {
    const response = await this.dispatch(stageInterventionCommandFrame({
      commandId: `stage-intervention:${input.interventionId}`,
      ...input,
    }));
    assertCommandAccepted(response);
    const data = response.result.status === "ok" && isRecord(response.result.data)
      ? response.result.data
      : undefined;
    const eventSourceSeq = typeof data?.eventSourceSeq === "number"
      ? data.eventSourceSeq
      : null;
    const queuePosition = typeof data?.queuePosition === "number"
      ? data.queuePosition
      : 0;
    if (eventSourceSeq !== null) {
      const record = await this.outbox.readRecord(eventSourceSeq);
      if (!record) throw new Error("staged runner intervention event is missing");
      this.latestPendingRecord = record;
      await this.ensurePump();
      this.pump?.notifyAvailable();
    }
    return { eventSourceSeq, queuePosition };
  }

  async applyIntervention(
    input: RunnerInterventionApplyInput,
  ): Promise<EngineInterventionResult> {
    const flushedFallback = await this.flushInterventionFallback(
      input.interventionId,
    );
    const response = await this.dispatch(applyInterventionCommandFrame({
      commandId: runnerInterventionApplyCommandId(input.interventionId),
      interventionId: input.interventionId,
      interventionInput: input.input,
    }));
    assertCommandAccepted(response);
    const normalized = normalizeRunnerInterventionResult(
      response.result.status === "ok" ? response.result.data : undefined,
    );
    if (flushedFallback && normalized.status === "delivered") {
      this.outbox.removeInterventionFallback(input.interventionId);
    }
    return normalized;
  }

  async discardIntervention(interventionId: string): Promise<void> {
    const response = await this.dispatch(discardInterventionCommandFrame({
      commandId: runnerInterventionDiscardCommandId(interventionId),
      interventionId,
    }));
    assertCommandAccepted(response);
    const data = response.result.status === "ok" ? response.result.data : undefined;
    if (isRecord(data) && data.status === "not_supported") {
      this.outbox.removeInterventionFallback(interventionId);
      return;
    }
    if (!isRecord(data) || data.status !== "discarded") {
      throw new Error("Runner child returned an invalid intervention discard result");
    }
    this.outbox.removeInterventionFallback(interventionId);
  }

  async recoverPendingInterventions(): Promise<RunnerPendingIntervention[]> {
    await this.ready;
    return await this.outbox.readPendingInterventions();
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
    this.spawnInput = await this.options.spawn;
    if (this.options.offlineExisting) {
      const paths = runnerProcessPaths(
        this.spawnInput.stateDirectory,
        this.spawnInput.sessionId,
      );
      this.socketPath = paths.socketPath;
      this.runnerDatabasePath = paths.databasePath;
      this.stoppedRunnerWriterLock = await RunnerWriterLock.acquire(paths.lockPath);
      try {
        this.stoppedRunnerWriter = await RunnerSqliteEventOutbox.open(paths.databasePath, {
          sessionId: this.spawnInput.sessionId,
        });
        this.outbox = await RunnerParentOutbox.open(
          paths.databasePath,
          this.spawnInput.sessionId,
          { onCheckpointAdvanced: async (ack) => await this.synchronizeChildCheckpoint(ack) },
        );
      } catch (error) {
        try {
          await this.releaseHostResources();
        } catch (cleanupError) {
          throw new AggregateError(
            [asError(error), asError(cleanupError)],
            "offline runner initialization and cleanup failed",
          );
        }
        throw error;
      }
      this.hostCallIdempotency = new RunnerHostCallIdempotency(this.outbox);
      return;
    }
    const spawner = this.options.spawner ?? new RunnerProcessSpawner();
    const spawned = this.options.adoptExisting
      ? await this.adoptExisting(spawner)
      : await spawner.spawn(this.spawnInput);
    this.socketPath = spawned.paths.socketPath;
    this.runnerDatabasePath = spawned.paths.databasePath;
    this.outbox = await RunnerParentOutbox.open(
      spawned.paths.databasePath,
      this.spawnInput.sessionId,
      { onCheckpointAdvanced: async (ack) => await this.synchronizeChildCheckpoint(ack) },
    );
    this.hostCallIdempotency = new RunnerHostCallIdempotency(this.outbox);
    await this.connect(spawned.paths.socketPath);
  }

  private async adoptExisting(
    spawner: RunnerProcessDispatcherOptions["spawner"] | RunnerProcessSpawner,
  ) {
    if (!spawner?.adopt) throw new Error("runner adopter unavailable");
    const adopted = await spawner.adopt({
      stateDirectory: this.spawnInput.stateDirectory,
      sessionId: this.spawnInput.sessionId,
    });
    if (!adopted) {
      throw new Error(`registered runner is not alive: ${this.spawnInput.sessionId}`);
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
      this.observeActiveExecution(commandId, "recover");
      const lifecycle = readRunnerSqliteLifecycle(this.runnerDatabasePath);
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
      await this.ready;
      let flushedFallback = false;
      if (params.runnerInterventionId) {
        flushedFallback = await this.flushInterventionFallback(
          params.runnerInterventionId,
          true,
        );
      }
      this.observeActiveExecution(commandId, "execute");
      assertCommandAccepted(await this.dispatch(executeCommandFrame(commandId, params)));
      if (flushedFallback && params.runnerInterventionId) {
        this.outbox.removeInterventionFallback(params.runnerInterventionId);
      }
      await this.replayPendingFrames();
    } catch (error) {
      stream.fail(asError(error));
      this.clearActiveExecution(commandId);
    }
  }

  private async flushInterventionFallback(
    interventionId: string,
    queuedOverride?: boolean,
  ): Promise<boolean> {
    await this.ready;
    const fallback = this.outbox.readInterventionFallback(interventionId);
    if (!fallback) return false;
    const staged = await this.stageInterventionInChild({
      interventionId: fallback.interventionId,
      message: fallback.message,
      ...(fallback.event ? { event: fallback.event } : {}),
      queued: queuedOverride ?? fallback.queued,
    });
    if (fallback.event) {
      const eventId = await this.waitForSessionAck();
      if (staged.eventSourceSeq === null || eventId === null) {
        throw new Error("host fallback intervention event did not reach durable ACK boundary");
      }
    }
    this.options.logger.info(
      {
        sessionId: this.spawnInput.sessionId,
        interventionId,
        durability: "runner_sqlite",
      },
      "Runner intervention host fallback flushed to child inbox",
    );
    return true;
  }

  private async connect(socketPath: string): Promise<RunnerIpcConnection> {
    const connection = await connectRunnerSocket(socketPath, {
      timeoutMs: 500,
      deadlineMs: RUNNER_SOCKET_CONNECT_DEADLINE_MS,
      retryDelayMs: RUNNER_SOCKET_CONNECT_RETRY_MS,
      onFrameDropped: (drop) => this.logDroppedFrame(drop),
    });
    this.attachConnection(connection, socketPath);
    return connection;
  }

  private logDroppedFrame(drop: RunnerDroppedFrame): void {
    this.droppedFrameCount += 1;
    this.options.logger.error(
      runnerDroppedFrameLogContext(drop, this.droppedFrameCount),
      "Invalid observational runner frame dropped",
    );
  }

  private attachConnection(connection: RunnerIpcConnection, socketPath: string): void {
    this.connection?.close();
    this.connection = connection;
    const connectedAtMs = (this.options.now ?? Date.now)();
    connection.onFrame(async (frame) => await this.handleFrame(frame));
    connection.onFailure((error) => {
      if (this.connection !== connection || this.closed) return;
      this.connection = undefined;
      const connectedForMs = Math.max(
        0,
        (this.options.now ?? Date.now)() - connectedAtMs,
      );
      if (connectedForMs >= this.reconnectPolicy.stableConnectionMs) {
        this.reconnectAttempts = 0;
      }
      this.requestReconnect(socketPath, error, connectedForMs);
    });
    void this.replayPendingFrames().catch((error) => {
      this.options.logger.error({ err: error }, "Runner IPC replay failed");
      this.activeStream?.fail(asError(error));
    });
  }

  private requestReconnect(
    socketPath: string,
    error: Error,
    connectedForMs: number,
  ): void {
    if (this.closed || this.reconnectExhaustedError) return;
    this.reconnectRequested = true;
    this.reconnectCause = error;
    if (this.reconnectInFlight) return;
    const reconnect = this.runReconnectLoop(socketPath, connectedForMs).finally(() => {
      if (this.reconnectInFlight === reconnect) this.reconnectInFlight = undefined;
      if (this.reconnectRequested && !this.closed && !this.reconnectExhaustedError) {
        this.requestReconnect(
          socketPath,
          this.reconnectCause ?? error,
          0,
        );
      }
    });
    this.reconnectInFlight = reconnect;
  }

  private async runReconnectLoop(
    socketPath: string,
    firstConnectedForMs: number,
  ): Promise<void> {
    let connectedForMs = firstConnectedForMs;
    while (this.reconnectRequested && !this.closed && !this.reconnectExhaustedError) {
      this.reconnectRequested = false;
      const reconnectAttempt = this.reconnectAttempts + 1;
      if (reconnectAttempt > this.reconnectPolicy.maxAttempts) {
        this.exhaustReconnectBudget(socketPath);
        return;
      }
      this.reconnectAttempts = reconnectAttempt;
      const reconnectDelayMs = Math.min(
        this.reconnectPolicy.maxDelayMs,
        this.reconnectPolicy.initialDelayMs * 2 ** (reconnectAttempt - 1),
      );
      this.options.logger.warn(
        {
          err: this.reconnectCause,
          ...this.runnerIdentityContext(socketPath),
          connectedForMs,
          reconnectAttempt,
          reconnectDelayMs,
          reconnectMaxAttempts: this.reconnectPolicy.maxAttempts,
        },
        "Runner IPC disconnected; reconnecting",
      );
      await (this.options.reconnectSleep ?? sleep)(reconnectDelayMs);
      if (this.closed || this.reconnectExhaustedError) return;
      try {
        await this.connect(socketPath);
      } catch (error) {
        if (this.closed) return;
        this.reconnectCause = asError(error);
        this.reconnectRequested = true;
        connectedForMs = 0;
      }
    }
  }

  private exhaustReconnectBudget(socketPath: string): void {
    const error = new Error(
      `Runner IPC reconnect budget exhausted after ${this.reconnectPolicy.maxAttempts} attempts`,
      { cause: this.reconnectCause },
    );
    this.reconnectExhaustedError = error;
    this.abortRequestLifetimes(error);
    this.options.logger.error(
      {
        err: this.reconnectCause,
        ...this.runnerIdentityContext(socketPath),
        reconnectAttempts: this.reconnectAttempts,
      },
      "Runner IPC reconnect budget exhausted; runner execution will be terminalized",
    );
    // The active stream is the single terminal bridge into TaskExecutor; its
    // rejection persists the runner failure before finalizer cleanup.
    this.activeStream?.fail(error);
  }

  private runnerIdentityContext(socketPath: string): {
    sessionId: string;
    runnerDirectory: string;
    socketPath: string;
  } {
    return {
      sessionId: this.spawnInput.sessionId,
      runnerDirectory: runnerProcessPaths(
        this.spawnInput.stateDirectory,
        this.spawnInput.sessionId,
      ).sessionDirectory,
      socketPath,
    };
  }

  private async ensureConnection(): Promise<RunnerIpcConnection> {
    if (this.connection) return this.connection;
    if (this.reconnectExhaustedError) throw this.reconnectExhaustedError;
    if (this.reconnectInFlight) {
      await this.reconnectInFlight;
      if (this.connection) return this.connection;
      if (this.reconnectExhaustedError) throw this.reconnectExhaustedError;
    }
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
      await this.hostCallIdempotency.acknowledge(frame.correlationId).catch((error) => {
        this.options.logger.error({
          err: error,
          correlationId: frame.correlationId,
        }, "Runner host-call receipt cleanup deferred; durable owner remains authoritative");
      });
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
    // Socket attachment and recovery both replay immediately; publish one
    // initialization before the bootstrap read yields so they cannot double-register.
    if (!this.pumpInitialization) {
      this.pumpInitialization = this.initializePump().finally(() => {
        this.pumpInitialization = undefined;
      });
    }
    await this.pumpInitialization;
  }

  private async initializePump(): Promise<void> {
    if (this.pump) return;
    const bootstrap = await this.outbox.readBootstrap();
    if (!bootstrap) return;
    const pump = new EventOutboxPump(this.outbox, (error) => {
      this.options.logger.error({ err: error }, "Runner event outbox pump failed");
    }, {
      onQuarantine: (result) => {
        this.options.logger.warn({
          path: result.path,
          sourceSeq: result.sourceSeq,
          sessionId: result.sessionId,
          code: result.code,
          attempts: result.attempts,
        }, "Runner event outbox head quarantined after repeated rejection");
      },
    });
    const unregisterPump = this.options.pumpMux.register(pump);
    this.pump = pump;
    this.unregisterPump = unregisterPump;
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
    this.finishActiveRunnerObservation?.();
    this.finishActiveRunnerObservation = undefined;
    this.activeExecuteCommandId = undefined;
    this.activeStream = undefined;
    this.abortRequestLifetimes(new Error("Runner execution ended"));
  }

  private async sendBestEffort(frame: RunnerFrame): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await connection.send(frame).catch((error) => {
      this.options.logger.warn({ err: error }, "Runner host response dropped during reconnect");
    });
  }

  private async acknowledgeConsumedFrame(frameSeq: number): Promise<void> {
    this.latestConsumedFrameSeq = Math.max(this.latestConsumedFrameSeq ?? 0, frameSeq);
    if (this.stoppedRunnerWriter) {
      await this.stoppedRunnerWriter.acknowledgeHostFrame(frameSeq);
      return;
    }
    await this.sendBestEffort(hostFrameAppliedControlFrame(frameSeq));
  }

  private async synchronizeChildCheckpoint(acknowledgedThrough: number): Promise<void> {
    if (this.stoppedRunnerWriter) {
      await this.stoppedRunnerWriter.acknowledge(
        this.outbox.streamId,
        acknowledgedThrough,
      );
      return;
    }
    if (this.latestConsumedFrameSeq !== undefined) {
      await this.sendBestEffort(hostFrameAppliedControlFrame(this.latestConsumedFrameSeq));
    }
  }

  private async releaseHostResources(): Promise<void> {
    const finishActiveRunnerObservation = this.finishActiveRunnerObservation;
    this.finishActiveRunnerObservation = undefined;
    const connection = this.connection;
    this.connection = undefined;
    const unregisterPump = this.unregisterPump;
    this.unregisterPump = undefined;
    const outbox = this.outbox;
    this.outbox = undefined as never;
    const stoppedRunnerWriter = this.stoppedRunnerWriter;
    this.stoppedRunnerWriter = undefined;
    const stoppedRunnerWriterLock = this.stoppedRunnerWriterLock;
    this.stoppedRunnerWriterLock = undefined;
    await releaseRunnerHostResources([
      { name: "runner observation", run: () => finishActiveRunnerObservation?.() },
      { name: "IPC connection", run: () => connection?.close() },
      { name: "event pump registration", run: () => unregisterPump?.() },
      { name: "parent outbox", run: () => outbox?.close() },
      { name: "offline writer", run: () => stoppedRunnerWriter?.close() },
      { name: "offline writer lock", run: async () => await stoppedRunnerWriterLock?.release() },
    ]);
  }

  private observeActiveExecution(commandId: string, operation: "execute" | "recover"): void {
    this.finishActiveRunnerObservation?.();
    this.finishActiveRunnerObservation = this.options.nodeStallMonitor?.beginRunnerOperation({
      sessionId: this.spawnInput.sessionId,
      commandId,
      operation: `execution:${operation}`,
    });
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

function validateReconnectPolicy(policy: RunnerIpcReconnectPolicy): RunnerIpcReconnectPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`runner reconnect ${name} must be a positive integer`);
    }
  }
  if (policy.initialDelayMs > policy.maxDelayMs) {
    throw new Error("runner reconnect initialDelayMs cannot exceed maxDelayMs");
  }
  return { ...policy };
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}
