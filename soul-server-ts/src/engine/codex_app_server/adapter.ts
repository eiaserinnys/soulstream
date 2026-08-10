import type { Logger } from "pino";

import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import { sseEventsFromRunnerFrames } from "../../runner/engine_event_stream.js";
import type { InProcessRunnerFrameChannel } from "../../runner/in_process_frame_channel.js";
import {
  engineEventFrame,
  type RunnerEventFrame,
} from "../../runner/frame_protocol.js";
import { sanitizeCodexEnv } from "../codex_env.js";
import { withScratchWorkspaceEnv } from "../scratch_workspace_env.js";
import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  EngineUserInput,
  LiveTurnSteerResult,
  SSEEventPayload,
  SupportsLiveTurnSteering,
} from "../protocol.js";
import { AppServerRpcError, CodexAppServerClient } from "./client.js";
import {
  applyNotificationLifecycle,
  clearActiveTurn,
  createNotificationLifecycleState,
  recordThreadOpened,
  recordTurnStartResponse,
  type NotificationLifecycleState,
} from "./notification_lifecycle.js";
import {
  createStdioAppServerTransport,
  type AppServerTransportLogger,
} from "./stdio_transport.js";
import type {
  AppServerNotification,
  AppServerRequestId,
  AppServerResponseError,
  AppServerServerRequest,
  InitializeParams,
  InitializeResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "./protocol.js";
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  selectCodexMcpServers,
} from "./params.js";
import { toCodexUserInput } from "./protocol.js";
import { AsyncPayloadQueue } from "./async_payload_queue.js";

const CLIENT_INFO: InitializeParams["clientInfo"] = {
  name: "soul-server-ts",
  version: "0.0.1",
};

export interface CodexAppServerClientPort {
  initialize(params: InitializeParams): Promise<InitializeResponse>;
  startThread(params: ThreadStartParams): Promise<ThreadStartResponse>;
  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse>;
  startTurn(params: TurnStartParams): Promise<TurnStartResponse>;
  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse>;
  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse>;
  onNotification(handler: (notification: AppServerNotification) => void): () => void;
  onServerRequest(handler: (request: AppServerServerRequest) => void): () => void;
  resolveServerRequest(id: AppServerRequestId, result: unknown): Promise<void>;
  rejectServerRequest(id: AppServerRequestId, error: AppServerResponseError): Promise<void>;
  onError(handler: (error: Error) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface CodexAppServerAdapterConfig {
  workspaceDir: string;
  agentId?: string;
  apiKey?: string;
  codexPathOverride?: string;
  processEnv?: NodeJS.ProcessEnv;
  client?: CodexAppServerClientPort;
  resolvedMcpServers?: ResolvedMcpServer[];
}

export class CodexAppServerEngineAdapter
  implements EnginePort, SupportsLiveTurnSteering
{
  public readonly backendId: BackendId = "codex";
  public readonly workspaceDir: string;

  private readonly logger: Logger;
  private readonly client: CodexAppServerClientPort;
  private readonly resolvedMcpServers?: ResolvedMcpServer[];
  private initialized = false;
  private executing = false;
  private closed = false;
  private notificationLifecycle: NotificationLifecycleState =
    createNotificationLifecycleState();
  private activeQueue: AsyncPayloadQueue<SSEEventPayload> | null = null;

  constructor(config: CodexAppServerAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.logger = logger;
    this.client = config.client ?? this.createClient(config, logger);
    const { supportedServers, skippedSseServers } = selectCodexMcpServers(
      config.resolvedMcpServers,
    );
    this.resolvedMcpServers = supportedServers;
    for (const server of skippedSseServers) {
      this.logger.warn(
        {
          agentId: config.agentId ?? "unknown",
          serverName: server.name?.trim() || "unknown",
          transport: server.type,
          reason:
            "Codex app-server supports stdio and streamable_http MCP transports only",
        },
        "Skipping unsupported MCP server for Codex backend",
      );
    }
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    yield* sseEventsFromRunnerFrames(this.executeFrames(params));
  }

  async executeToFrameChannel(
    params: EngineExecuteParams,
    channel: InProcessRunnerFrameChannel,
  ): Promise<void> {
    for await (const frame of this.executeFrames(params)) await channel.emit(frame);
  }

  async *executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    if (this.closed) {
      throw new Error("CodexAppServerEngineAdapter.execute called after close()");
    }
    if (this.executing) {
      throw new Error("CodexAppServerEngineAdapter.execute: concurrent turn not supported");
    }

    this.executing = true;
    const queue = new AsyncPayloadQueue<SSEEventPayload>();
    this.activeQueue = queue;
    const unsubscribe = [
      this.client.onNotification((notification) => {
        this.handleNotification(notification, queue, Boolean(params.resumeSessionId));
      }),
      this.client.onServerRequest((request) => {
        this.handleServerRequest(request, queue);
      }),
      this.client.onError((error) => {
        queue.push(fatalErrorPayload(error));
        queue.close();
      }),
      this.client.onClose((error) => {
        queue.push(fatalErrorPayload(error ?? new Error("Codex app-server transport closed")));
        queue.close();
      }),
    ];

    try {
      await this.ensureInitialized();
      if (!this.closed) {
        const threadId = await this.openThread(params, queue);
        if (!this.closed && threadId) {
          const turnResponse = await this.client.startTurn(
            buildTurnStartParams(threadId, params, this.workspaceDir),
          );
          if (!this.closed) {
            const turnStart = recordTurnStartResponse(
              this.notificationLifecycle,
              threadId,
              turnResponse.turn,
            );
            this.notificationLifecycle = turnStart.state;
            if (turnStart.closeQueue) {
              queue.close();
            }
          }
        }
      }

      for await (const payload of queue) {
        yield engineEventFrame(payload as Record<string, unknown>);
      }
    } catch (error) {
      if (this.closed) {
        for await (const payload of queue) {
          yield engineEventFrame(payload as Record<string, unknown>);
        }
        return;
      }
      yield engineEventFrame(
        fatalErrorPayload(error instanceof Error ? error : new Error(String(error))) as Record<
          string,
          unknown
        >,
      );
    } finally {
      for (const off of unsubscribe) off();
      this.notificationLifecycle = clearActiveTurn(this.notificationLifecycle);
      this.activeQueue = null;
      this.executing = false;
    }
  }

  async steerActiveTurn(input: EngineUserInput): Promise<LiveTurnSteerResult> {
    const activeTurn = this.notificationLifecycle.activeTurn;
    if (!activeTurn) {
      return {
        status: "no_active_turn",
        message: "No active Codex app-server turn",
      };
    }

    try {
      const result = await this.client.steerTurn({
        threadId: activeTurn.threadId,
        expectedTurnId: activeTurn.turnId,
        input: toCodexUserInput(input),
      });
      if (result.turnId !== activeTurn.turnId) {
        return {
          status: "turn_mismatch",
          message: `Codex app-server steered turn ${result.turnId}, expected ${activeTurn.turnId}`,
        };
      }
      return { status: "delivered" };
    } catch (error) {
      return mapSteerError(error);
    }
  }

  async interrupt(): Promise<boolean> {
    const activeTurn = this.notificationLifecycle.activeTurn;
    if (!activeTurn) {
      this.logger.debug("Codex app-server interrupt called with no active turn");
      return false;
    }
    try {
      await this.client.interruptTurn({
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
      });
      return true;
    } catch (error) {
      this.logger.warn({ error }, "Codex app-server interrupt failed");
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.notificationLifecycle = clearActiveTurn(this.notificationLifecycle);
    this.activeQueue?.close();
    await this.client.close();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.client.initialize({
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    this.initialized = true;
  }

  private async openThread(
    params: EngineExecuteParams,
    queue: AsyncPayloadQueue<SSEEventPayload>,
  ): Promise<string | null> {
    if (params.resumeSessionId) {
      let response: ThreadResumeResponse;
      try {
        response = await this.client.resumeThread(
          buildThreadResumeParams(
            params,
            this.workspaceDir,
            this.resolvedMcpServers,
          ),
        );
      } catch (error) {
        if (isNoRolloutFoundResumeError(error)) {
          this.logger.warn(
            { error, threadId: params.resumeSessionId },
            "Codex app-server resume skipped: rollout not found",
          );
          queue.close();
          return null;
        }
        throw error;
      }
      if (this.closed) return null;
      return response.thread.id;
    }

    const response = await this.client.startThread(
      buildThreadStartParams(
        params,
        this.workspaceDir,
        this.resolvedMcpServers,
      ),
    );
    if (this.closed) return null;
    const threadId = response.thread.id;
    const opened = recordThreadOpened(this.notificationLifecycle, threadId);
    this.notificationLifecycle = opened.state;
    if (opened.emitSession) {
      const payload = { type: "session", session_id: threadId } as SSEEventPayload;
      queue.push(payload);
    }
    return threadId;
  }

  private handleNotification(
    notification: AppServerNotification,
    queue: AsyncPayloadQueue<SSEEventPayload>,
    suppressThreadStartedSession: boolean,
  ): void {
    const result = applyNotificationLifecycle(this.notificationLifecycle, notification, {
      suppressThreadStartedSession,
    });
    this.notificationLifecycle = result.state;

    for (const payload of result.payloads) {
      queue.push(payload);
    }
    if (result.closeQueue) {
      queue.close();
    }
  }

  private handleServerRequest(
    request: AppServerServerRequest,
    queue: AsyncPayloadQueue<SSEEventPayload>,
  ): void {
    const message = `Unsupported Codex app-server server request: ${request.method}`;
    this.logger.warn(
      { requestId: request.id, method: request.method },
      "Codex app-server server request received; rejecting by default",
    );
    void this.client
      .rejectServerRequest(request.id, {
        code: -32000,
        message,
      })
      .then(() => {
        this.logger.warn(
          { requestId: request.id, method: request.method, code: -32000 },
          "Codex app-server server request rejection sent",
        );
        queue.push({
          type: "debug",
          message: `Rejected Codex app-server server request: ${request.method}`,
          timestamp: Date.now() / 1000,
          raw_event_type: request.method,
        } as SSEEventPayload);
      })
      .catch((error: unknown) => {
        const rejectionError =
          error instanceof Error ? error : new Error(String(error));
        this.logger.error(
          { error: rejectionError, requestId: request.id, method: request.method },
          "Codex app-server server request rejection failed",
        );
        queue.push(fatalErrorPayload(rejectionError));
        queue.close();
      });
  }

  private createClient(
    config: CodexAppServerAdapterConfig,
    logger: Logger,
  ): CodexAppServerClientPort {
    const env = withScratchWorkspaceEnv(
      sanitizeCodexEnv(config.processEnv ?? process.env),
      { workspaceDir: config.workspaceDir, agentId: config.agentId },
    );
    if (config.apiKey && config.apiKey.trim()) {
      env.CODEX_API_KEY = config.apiKey;
    }
    const transport = createStdioAppServerTransport({
      command: config.codexPathOverride,
      cwd: config.workspaceDir,
      env,
      logger: logger as AppServerTransportLogger,
    });
    return new CodexAppServerClient(transport);
  }
}

function fatalErrorPayload(error: Error): SSEEventPayload {
  return {
    type: "error",
    message: error.message,
    fatal: true,
    timestamp: Date.now() / 1000,
  } as SSEEventPayload;
}

function isNoRolloutFoundResumeError(error: unknown): boolean {
  if (!(error instanceof AppServerRpcError)) return false;
  if (error.code !== -32600) return false;
  return error.message.toLowerCase().includes("no rollout found");
}

function mapSteerError(error: unknown): LiveTurnSteerResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AppServerRpcError && error.code === -32601) {
    return { status: "not_supported", message };
  }
  const lower = message.toLowerCase();
  if (lower.includes("no active") || lower.includes("active turn")) {
    return { status: "no_active_turn", message };
  }
  if (lower.includes("expected") || lower.includes("mismatch")) {
    return { status: "turn_mismatch", message };
  }
  return { status: "failed", message };
}
