import type { Logger } from "pino";

import { sanitizeCodexEnv } from "../codex_env.js";
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
} from "./params.js";
import { toCodexUserInput } from "./protocol.js";

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
  onError(handler: (error: Error) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface CodexAppServerAdapterConfig {
  workspaceDir: string;
  apiKey?: string;
  codexPathOverride?: string;
  processEnv?: NodeJS.ProcessEnv;
  client?: CodexAppServerClientPort;
}

export class CodexAppServerEngineAdapter
  implements EnginePort, SupportsLiveTurnSteering
{
  public readonly backendId: BackendId = "codex";
  public readonly workspaceDir: string;

  private readonly logger: Logger;
  private readonly client: CodexAppServerClientPort;
  private initialized = false;
  private executing = false;
  private closed = false;
  private notificationLifecycle: NotificationLifecycleState =
    createNotificationLifecycleState();
  private activeQueue: AsyncPayloadQueue | null = null;

  constructor(config: CodexAppServerAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.logger = logger;
    this.client = config.client ?? this.createClient(config, logger);
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    if (this.closed) {
      throw new Error("CodexAppServerEngineAdapter.execute called after close()");
    }
    if (this.executing) {
      throw new Error("CodexAppServerEngineAdapter.execute: concurrent turn not supported");
    }

    this.executing = true;
    const queue = new AsyncPayloadQueue();
    this.activeQueue = queue;
    const unsubscribe = [
      this.client.onNotification((notification) => {
        this.handleNotification(notification, queue, Boolean(params.resumeSessionId));
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
      const threadId = await this.openThread(params, queue);
      const turnResponse = await this.client.startTurn(
        buildTurnStartParams(threadId, params, this.workspaceDir),
      );
      const turnStart = recordTurnStartResponse(
        this.notificationLifecycle,
        threadId,
        turnResponse.turn,
      );
      this.notificationLifecycle = turnStart.state;
      if (turnStart.closeQueue) {
        queue.close();
      }

      for await (const payload of queue) {
        if (params.onEvent) {
          await params.onEvent(payload);
        }
        yield payload;
      }
    } catch (error) {
      yield fatalErrorPayload(error instanceof Error ? error : new Error(String(error)));
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
    queue: AsyncPayloadQueue,
  ): Promise<string> {
    if (params.resumeSessionId) {
      const response = await this.client.resumeThread(
        buildThreadResumeParams(params, this.workspaceDir),
      );
      return response.thread.id;
    }

    const response = await this.client.startThread(
      buildThreadStartParams(params, this.workspaceDir),
    );
    const threadId = response.thread.id;
    const opened = recordThreadOpened(this.notificationLifecycle, threadId);
    this.notificationLifecycle = opened.state;
    if (opened.emitSession) {
      const payload = { type: "session", session_id: threadId } as SSEEventPayload;
      queue.push(payload);
    }
    if (opened.reportSession) {
      await params.onSession?.(threadId);
    }
    return threadId;
  }

  private handleNotification(
    notification: AppServerNotification,
    queue: AsyncPayloadQueue,
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

  private createClient(
    config: CodexAppServerAdapterConfig,
    logger: Logger,
  ): CodexAppServerClientPort {
    const env = sanitizeCodexEnv(config.processEnv ?? process.env);
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

class AsyncPayloadQueue implements AsyncIterable<SSEEventPayload> {
  private readonly items: SSEEventPayload[] = [];
  private readonly waiters: Array<(result: IteratorResult<SSEEventPayload>) => void> = [];
  private closed = false;

  push(item: SSEEventPayload): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SSEEventPayload> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<SSEEventPayload>> {
    const item = this.items.shift();
    if (item) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
