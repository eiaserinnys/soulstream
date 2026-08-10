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
import { InProcessRunnerCommandDispatcher } from "./runner_command_dispatcher.js";
import type { RunnerChildConfig } from "./runner_process_spawn.js";
import { RunnerSocketEndpoint } from "./runner_socket_endpoint.js";
import { RunnerSqliteEventOutbox } from "./sqlite_event_outbox.js";
import { RunnerWriterLock } from "./runner_writer_lock.js";

const REQUIRED_HOST_SEND_ATTEMPTS = 3;
const REQUIRED_HOST_SEND_RETRY_MS = 100;

export class RunnerChildRuntime {
  private endpoint!: RunnerSocketEndpoint;
  private outbox!: RunnerSqliteEventOutbox;
  private lock!: RunnerWriterLock;
  private dispatcher!: InProcessRunnerCommandDispatcher;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private closing = false;

  constructor(
    private readonly config: RunnerChildConfig,
    private readonly logger: Logger,
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  async start(): Promise<void> {
    this.lock = await RunnerWriterLock.acquire(this.config.paths.lockPath);
    this.outbox = await RunnerSqliteEventOutbox.open(this.config.paths.databasePath);
    this.endpoint = new RunnerSocketEndpoint(
      this.config.paths.socketPath,
      async (frame) => await this.handleFrame(frame),
      (error) => this.logger.warn({ error }, "Runner host socket disconnected"),
    );
    const host = new RunnerHostRequestClient(() => this.endpoint.currentConnection);
    this.dispatcher = new InProcessRunnerCommandDispatcher(
      createRunnerChildEngine(this.config, host, this.logger),
    );
    await setRunnerOomScore();
    await this.endpoint.listen();
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
      void this.drainExecution(command).catch((error) => {
        this.logger.error({ error }, "Runner execution drain failed");
      });
      return;
    }
    if (command.kind === "close") {
      queueMicrotask(() => { void this.shutdown(); });
    }
  }

  private async drainExecution(
    command: Extract<RunnerCommandFrame, { kind: "execute" }>,
  ): Promise<void> {
    let terminalError: { code: string; message: string } | undefined;
    try {
      if (command.params.resumeSessionId) {
        await this.ensureBootstrap(command.params.resumeSessionId);
      }
      for await (const frame of this.dispatcher.events(command.commandId)) {
        await this.forwardRunnerFrame(frame);
      }
    } catch (error) {
      await this.dispatcher.interrupt().catch(() => false);
      terminalError = {
        code: "execution_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const ended = executionEndedControlFrame(command.commandId, terminalError);
    await this.sendRequired(ended).catch((error) => {
      this.logger.warn({ error }, "Runner execution end could not reach host");
    });
  }

  private async forwardRunnerFrame(frame: RunnerEventFrame): Promise<void> {
    if (frame.kind === "run_state_snapshot") {
      await this.callHostSnapshot("persistRunState", frame.snapshot);
      return;
    }
    if (frame.kind === "session_items_snapshot") {
      await this.callHostSnapshot("persistSessionItems", frame.snapshot);
      return;
    }
    if (frame.kind === "request") {
      await this.sendRequired(frame);
      return;
    }
    const event = frame.payload as SSEEventPayload;
    if (!shouldPersistEvent(event)) {
      await this.sendBestEffort(frame);
      return;
    }
    const effect = sessionIdEffect(event);
    const backendSessionId = effect?.kind === "set_backend_session_id"
      ? effect.backend_session_id
      : null;
    if (!(await this.outbox.readBootstrap())) {
      await this.ensureBootstrap(backendSessionId);
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
  }

  private async ensureBootstrap(backendSessionId: string | null): Promise<void> {
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
  }

  private async callHostSnapshot(operation: string, snapshot: unknown): Promise<void> {
    const host = new RunnerHostRequestClient(() => this.endpoint.currentConnection);
    await host.call("snapshot", operation, [this.config.sessionId, snapshot], {
      timeoutMs: 30_000,
      attempts: 3,
      retryDelayMs: 100,
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

export async function setRunnerOomScore(
  platform: NodeJS.Platform = process.platform,
  path = "/proc/self/oom_score_adj",
): Promise<void> {
  if (platform !== "linux") return;
  await writeFile(path, "500\n");
}
