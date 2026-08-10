import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import type {
  SessionStore,
  SessionStoreFlush,
} from "@anthropic-ai/claude-agent-sdk";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import { sseEventsFromRunnerFrames } from "../runner/engine_event_stream.js";
import {
  DEFAULT_RUNNER_REQUEST_TIMEOUT_MS,
  InProcessRunnerFrameChannel,
} from "../runner/in_process_frame_channel.js";
import {
  engineEventFrame,
  runnerRequestFrame,
  type RunnerControlFrame,
  type RunnerEventFrame,
} from "../runner/frame_protocol.js";
import { readClaudeBackgroundDeliveryMetadata } from
  "./claude_background_delivery_metadata.js";
import { readClaudeBackgroundProvenance } from "./claude_background_provenance.js";
import type {
  BackendId,
  EngineUserInput,
  EngineExecuteParams,
  EnginePort,
  InputResponseDeliveryResult,
  ClaudePermissionMode,
  ClaudeBackgroundTaskControlResult,
  LiveTurnSteerResult,
  ScheduleToolUseHandler,
  SSEEventPayload,
  SupportsClaudeBackgroundTasks,
  SupportsCompact,
  SupportsInputResponse,
  SupportsLiveTurnSteering,
} from "./protocol.js";
import {
  mapClaudeClientEvent,
  type ClaudeClientEvent,
} from "./claude_event_mapper.js";
import {
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";
import { ClaudeSdkClient } from "./claude_sdk_client.js";
import type { ClaudeSessionClientRegistry } from "./claude_session_client_registry.js";
import type { ClaudePersistentRuntimeActivity } from "./claude_session_runtime.js";
import { withScratchWorkspaceEnv } from "./scratch_workspace_env.js";

export {
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_PROMPT_SUGGESTION_ENV,
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";
export { ClaudeSdkClient } from "./claude_sdk_client.js";
export type { ClaudeClientEvent } from "./claude_event_mapper.js";

export interface ClaudeRunOptions {
  agentSessionId?: string;
  prompt: string;
  inputUuid?: string;
  workspaceDir: string;
  imageAttachmentPaths?: string[];
  resumeSessionId?: string;
  model?: string;
  systemPrompt?: string;
  /** Python `agents.yaml.allowed_tools` → Claude SDK `ClaudeAgentOptions.allowedTools`. */
  allowedTools?: string[];
  /** Python `agents.yaml.disallowed_tools` → Claude SDK `disallowedTools`. */
  disallowedTools?: string[];
  /** Python `agents.yaml.max_turns` → Claude SDK `maxTurns`. */
  maxTurns?: number;
  /** Python `Task.use_mcp` → SDK mcpServers 로딩 게이트. undefined면 true. */
  useMcp?: boolean;
  /** `mcp_profile`에서 resolve한 서버. undefined면 workspace MCP config 폴백. */
  resolvedMcpServers?: ResolvedMcpServer[];
  /** Claude Agent SDK permissionMode. undefined면 legacy bypassPermissions. */
  claudePermissionMode?: ClaudePermissionMode;
  env?: Record<string, string>;
  onScheduleToolUse?: ScheduleToolUseHandler;
  sessionStore?: SessionStore;
  sessionStoreFlush?: SessionStoreFlush;
  loadTimeoutMs?: number;
}

export interface ClaudeClient {
  run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent>;
  runPersistent?(
    options: ClaudeRunOptions,
    signal: AbortSignal,
  ): AsyncIterable<ClaudeClientEvent>;
  compact?(sessionId: string): Promise<void>;
  deliverInputResponse?(
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<boolean> | boolean;
  backgroundClaudeRuntimeTasks?(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> | ClaudeBackgroundTaskControlResult;
  stopClaudeRuntimeTask?(
    taskId: string,
  ): Promise<ClaudeBackgroundTaskControlResult> | ClaudeBackgroundTaskControlResult;
  steerActiveTurn?(
    input: EngineUserInput,
  ): Promise<LiveTurnSteerResult> | LiveTurnSteerResult;
  interruptActiveTurnForSteer?(): Promise<boolean>;
  interrupt?(): Promise<boolean>;
  persistentRuntimeActivity?(): ClaudePersistentRuntimeActivity | null;
  close?(reason?: import("./claude_session_runtime.js").ClaudeRuntimeCloseReason): Promise<void>;
}

export interface ClaudeAdapterConfig {
  workspaceDir: string;
  agentId?: string;
  client?: ClaudeClient;
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  sessionStore?: SessionStore;
  sessionStoreFlush?: SessionStoreFlush;
  loadTimeoutMs?: number;
  resolvedMcpServers?: ResolvedMcpServer[];
  persistentSessionRegistry?: Pick<
    ClaudeSessionClientRegistry,
    "acquire" | "close" | "release" | "reserve"
  >;
}

export class ClaudeEngineAdapter
  implements
    EnginePort,
    SupportsInputResponse,
    SupportsCompact,
    SupportsClaudeBackgroundTasks,
    SupportsLiveTurnSteering
{
  public readonly backendId: BackendId = "claude";
  public readonly workspaceDir: string;
  public readonly detachedClaudeRuntime: true | undefined;

  private readonly client: ClaudeClient;
  private readonly logger: Logger;
  private readonly agentId?: string;
  private readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  private readonly sessionStore?: SessionStore;
  private readonly sessionStoreFlush?: SessionStoreFlush;
  private readonly loadTimeoutMs?: number;
  private readonly resolvedMcpServers?: ResolvedMcpServer[];
  private readonly persistentSessionRegistry?: Pick<
    ClaudeSessionClientRegistry,
    "acquire" | "close" | "release" | "reserve"
  >;
  private activeClient: ClaudeClient | null = null;
  private persistentSessionId: string | null = null;
  private activeFrameChannel: InProcessRunnerFrameChannel | null = null;
  private currentTurn: AbortController | null = null;
  private closed = false;
  private readonly inputRequests = new Map<string, "pending" | "responded" | "expired">();

  constructor(config: ClaudeAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.detachedClaudeRuntime = config.persistentSessionRegistry ? true : undefined;
    this.agentId = config.agentId;
    this.client = config.client ?? new ClaudeSdkClient({}, logger);
    this.processEnv = config.processEnv;
    this.sessionStore = config.sessionStore;
    this.sessionStoreFlush = config.sessionStoreFlush;
    this.loadTimeoutMs = config.loadTimeoutMs;
    this.resolvedMcpServers = config.resolvedMcpServers;
    this.persistentSessionRegistry = config.persistentSessionRegistry;
    this.logger = logger;
  }

  prepareSessionRuntime(agentSessionId: string): void {
    this.persistentSessionRegistry?.reserve(agentSessionId);
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    yield* sseEventsFromRunnerFrames(this.executeFrames(params));
  }

  executeFrames(params: EngineExecuteParams): AsyncIterable<RunnerEventFrame> {
    const channel = new InProcessRunnerFrameChannel();
    channel.start(() => this.executeToFrames(params, channel));
    return channel;
  }

  private async executeToFrames(
    params: EngineExecuteParams,
    channel: InProcessRunnerFrameChannel,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("ClaudeEngineAdapter.execute called after close()");
    }
    if (this.currentTurn) {
      throw new Error(
        "ClaudeEngineAdapter.execute: concurrent turn not supported — call interrupt()+drain previous turn first",
      );
    }

    const controller = new AbortController();
    this.currentTurn = controller;
    this.activeFrameChannel = channel;
    const options = this.buildRunOptions(params, channel, controller.signal);
    const client = this.resolveClient(params.agentSessionId);
    this.activeClient = client;
    let lastText: string | undefined;

    try {
      const events = this.persistentSessionRegistry
        ? client.runPersistent?.(options, controller.signal)
        : client.run(options, controller.signal);
      if (!events) {
        throw new Error("Persistent Claude client does not implement runPersistent()");
      }
      for await (const clientEvent of events) {
        this.trackInputRequest(clientEvent);

        if (clientEvent.type === "text") {
          lastText = clientEvent.text;
        }

        const payloads = mapClaudeClientEvent(clientEvent, {
          fallbackResult: lastText,
        });
        for (const payload of payloads) {
          await channel.emit(engineEventFrame(
            { ...payload } as Record<string, unknown>,
            claudeEngineEventMetadata(payload),
          ));
        }

        if (clientEvent.type === "error" && clientEvent.fatal !== false) {
          throw new ClaudeClientFatalEventError(clientEvent.message);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.logger.info("Claude turn aborted by interrupt()");
        return;
      }
      if (!(err instanceof ClaudeClientFatalEventError)) {
        this.logger.warn({ err }, "Claude client stream error");
        const payload = {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          fatal: true,
          timestamp: nowSeconds(),
        } as SSEEventPayload;
        await channel.emit(engineEventFrame(payload as Record<string, unknown>));
      }
      throw err;
    } finally {
      this.currentTurn = null;
      this.activeFrameChannel = null;
    }
  }

  sendControlFrame(frame: RunnerControlFrame): boolean {
    return this.activeFrameChannel?.sendControl(frame) ?? false;
  }

  async interrupt(): Promise<boolean> {
    if (!this.currentTurn) {
      return false;
    }
    this.currentTurn.abort();
    const client = this.activeClient ?? this.client;
    if (client.interrupt) {
      const interrupted = await client.interrupt();
      if (this.persistentSessionRegistry && this.persistentSessionId) {
        await this.persistentSessionRegistry.close(
          this.persistentSessionId,
          "explicit_cancel",
        );
        this.activeClient = null;
      }
      return interrupted;
    }
    return true;
  }

  async interruptForSteer(): Promise<boolean> {
    if (!this.currentTurn) {
      return false;
    }
    const client = this.activeClient ?? this.client;
    if (client.interruptActiveTurnForSteer) {
      return await client.interruptActiveTurnForSteer();
    }
    if (client.interrupt) {
      return await client.interrupt();
    }
    return false;
  }

  async steerActiveTurn(input: EngineUserInput): Promise<LiveTurnSteerResult> {
    void input;
    return {
      status: "not_supported",
      message: "Claude live steering uses interruptForSteer",
    };
  }

  async compact(sessionId: string): Promise<void> {
    if (!sessionId) {
      throw new Error("ClaudeEngineAdapter.compact requires sessionId");
    }
    const client = this.activeClient ?? this.client;
    if (!client.compact) {
      throw new Error("Claude client does not support compact");
    }
    await client.compact(sessionId);
  }

  async backgroundClaudeRuntimeTasks(
    toolUseId?: string,
  ): Promise<ClaudeBackgroundTaskControlResult> {
    const client = this.activeClient ?? this.client;
    if (!client.backgroundClaudeRuntimeTasks) {
      return {
        status: "not_supported",
        message: "Claude client does not support background task control",
      };
    }
    return await client.backgroundClaudeRuntimeTasks(toolUseId);
  }

  async stopClaudeRuntimeTask(taskId: string): Promise<ClaudeBackgroundTaskControlResult> {
    const client = this.activeClient ?? this.client;
    if (!client.stopClaudeRuntimeTask) {
      return {
        status: "not_supported",
        message: "Claude client does not support background task control",
      };
    }
    return await client.stopClaudeRuntimeTask(taskId);
  }

  async deliverInputResponse(
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<InputResponseDeliveryResult> {
    const current = this.inputRequests.get(requestId);
    if (current === undefined) {
      return { status: "request_not_pending" };
    }
    if (current === "expired") {
      return { status: "expired" };
    }
    if (current === "responded") {
      return { status: "already_responded" };
    }
    const client = this.activeClient ?? this.client;
    if (!client.deliverInputResponse) {
      return {
        status: "not_supported",
        message: "Claude client does not support input responses",
      };
    }

    const delivered = await client.deliverInputResponse(requestId, answers);
    if (!delivered) {
      return { status: "request_not_pending" };
    }
    this.inputRequests.set(requestId, "responded");
    return { status: "delivered" };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.currentTurn) {
      this.currentTurn.abort();
      this.currentTurn = null;
    }
    this.inputRequests.clear();
    if (!this.persistentSessionRegistry) {
      await this.client.close?.();
    } else if (this.persistentSessionId) {
      this.persistentSessionRegistry.release(this.persistentSessionId);
    }
    this.activeClient = null;
  }

  private buildRunOptions(
    params: EngineExecuteParams,
    channel: InProcessRunnerFrameChannel,
    signal: AbortSignal,
  ): ClaudeRunOptions {
    const model = normalizeClaudeModel(params.model);
    const env = withScratchWorkspaceEnv(
      buildClaudeEnvironment({
        processEnv: this.processEnv,
        extraEnv: params.extraEnv,
      }),
      { workspaceDir: this.workspaceDir, agentId: this.agentId },
    );
    return {
      prompt: params.prompt,
      ...(params.inputUuid ? { inputUuid: params.inputUuid } : {}),
      ...(params.agentSessionId ? { agentSessionId: params.agentSessionId } : {}),
      workspaceDir: this.workspaceDir,
      ...(params.imageAttachmentPaths !== undefined
        ? { imageAttachmentPaths: params.imageAttachmentPaths }
        : {}),
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(model ? { model } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
      ...(params.disallowedTools !== undefined ? { disallowedTools: params.disallowedTools } : {}),
      ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
      ...(params.useMcp !== undefined ? { useMcp: params.useMcp } : {}),
      ...(this.resolvedMcpServers !== undefined
        ? { resolvedMcpServers: this.resolvedMcpServers }
        : {}),
      ...(params.claudePermissionMode !== undefined
        ? { claudePermissionMode: params.claudePermissionMode }
        : {}),
      env,
      ...(params.scheduleToolUseEnabled && params.agentSessionId
        ? {
            onScheduleToolUse: (request: Parameters<ScheduleToolUseHandler>[0]) =>
              this.requestScheduleToolUse(channel, request, signal),
          }
        : {}),
      ...(this.sessionStore !== undefined ? { sessionStore: this.sessionStore } : {}),
      ...(this.sessionStoreFlush !== undefined ? { sessionStoreFlush: this.sessionStoreFlush } : {}),
      ...(this.loadTimeoutMs !== undefined ? { loadTimeoutMs: this.loadTimeoutMs } : {}),
    };
  }

  private async requestScheduleToolUse(
    channel: InProcessRunnerFrameChannel,
    request: Parameters<ScheduleToolUseHandler>[0],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ScheduleToolUseHandler>>> {
    const correlationId = randomUUID();
    const timeoutMs = DEFAULT_RUNNER_REQUEST_TIMEOUT_MS;
    const control = await channel.request(runnerRequestFrame(correlationId, {
        kind: "schedule_tool_use",
        agentSessionId: request.agentSessionId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        now: request.now.toISOString(),
    }, { timeoutMs }), { signal, timeoutMs });
    if (control.kind !== "response") {
      throw new Error(`Unexpected schedule control frame: ${control.kind}`);
    }
    if (control.result.status === "error") {
      throw new Error(control.result.error.message);
    }
    const data = control.result.data;
    if (!isRecord(data) || typeof data.message !== "string") {
      throw new Error(`Invalid schedule control response: ${correlationId}`);
    }
    return {
      message: data.message,
      ...(data.data !== undefined ? { data: data.data } : {}),
    };
  }

  private resolveClient(agentSessionId: string | undefined): ClaudeClient {
    if (!this.persistentSessionRegistry) return this.client;
    if (!agentSessionId) {
      throw new Error("Persistent Claude runtime requires agentSessionId");
    }
    if (this.persistentSessionId === agentSessionId && this.activeClient) {
      return this.activeClient;
    }
    if (this.persistentSessionId && this.persistentSessionId !== agentSessionId) {
      throw new Error(
        `ClaudeEngineAdapter cannot switch persistent session: ${this.persistentSessionId} -> ${agentSessionId}`,
      );
    }
    this.persistentSessionId = agentSessionId;
    return this.persistentSessionRegistry.acquire(agentSessionId);
  }

  private trackInputRequest(event: ClaudeClientEvent): void {
    if (event.type === "input_request") {
      if (!this.inputRequests.has(event.requestId)) {
        this.inputRequests.set(event.requestId, "pending");
      }
      return;
    }
    if (event.type === "input_request_responded") {
      this.inputRequests.set(event.requestId, "responded");
      return;
    }
    if (event.type === "input_request_expired") {
      if (this.inputRequests.get(event.requestId) !== "responded") {
        this.inputRequests.set(event.requestId, "expired");
      }
    }
  }
}

class ClaudeClientFatalEventError extends Error {}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function claudeEngineEventMetadata(payload: SSEEventPayload): Record<string, unknown> | undefined {
  const provenance = readClaudeBackgroundProvenance(payload);
  const delivery = readClaudeBackgroundDeliveryMetadata(payload);
  if (!provenance && !delivery) return undefined;
  return {
    ...(provenance ? { claudeBackgroundProvenance: provenance } : {}),
    ...(delivery ? { claudeBackgroundDelivery: delivery } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
