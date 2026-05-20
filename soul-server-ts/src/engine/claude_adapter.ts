import type { Logger } from "pino";

import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  InputResponseDeliveryResult,
  SSEEventPayload,
  SupportsCompact,
  SupportsInputResponse,
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

export {
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_PROMPT_SUGGESTION_ENV,
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";
export { ClaudeSdkClient } from "./claude_sdk_client.js";
export type { ClaudeClientEvent } from "./claude_event_mapper.js";

export interface ClaudeRunOptions {
  prompt: string;
  workspaceDir: string;
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
  env: Record<string, string>;
  onIntervention?: () => Promise<string | null>;
}

export interface ClaudeClient {
  run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent>;
  compact?(sessionId: string): Promise<void>;
  deliverInputResponse?(
    requestId: string,
    answers: Record<string, unknown>,
  ): Promise<boolean> | boolean;
  interrupt?(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface ClaudeAdapterConfig {
  workspaceDir: string;
  client?: ClaudeClient;
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export class ClaudeEngineAdapter implements EnginePort, SupportsInputResponse, SupportsCompact {
  public readonly backendId: BackendId = "claude";
  public readonly workspaceDir: string;

  private readonly client: ClaudeClient;
  private readonly logger: Logger;
  private readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  private currentTurn: AbortController | null = null;
  private closed = false;
  private readonly inputRequests = new Map<string, "pending" | "responded" | "expired">();

  constructor(config: ClaudeAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.client = config.client ?? new ClaudeSdkClient({}, logger);
    this.processEnv = config.processEnv;
    this.logger = logger;
  }

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
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
    const options = this.buildRunOptions(params);
    let lastText: string | undefined;

    try {
      for await (const clientEvent of this.client.run(options, controller.signal)) {
        this.trackInputRequest(clientEvent);

        if (clientEvent.type === "session") {
          if (params.onSession) {
            await params.onSession(clientEvent.sessionId);
          }
        }

        if (clientEvent.type === "text") {
          lastText = clientEvent.text;
        }

        const payloads = mapClaudeClientEvent(clientEvent, {
          fallbackResult: lastText,
        });
        for (const payload of payloads) {
          if (params.onEvent) await params.onEvent(payload);
          yield payload;
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
        if (params.onEvent) await params.onEvent(payload);
        yield payload;
      }
      throw err;
    } finally {
      this.currentTurn = null;
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.currentTurn) {
      return false;
    }
    this.currentTurn.abort();
    if (this.client.interrupt) {
      return await this.client.interrupt();
    }
    return true;
  }

  async compact(sessionId: string): Promise<void> {
    if (!sessionId) {
      throw new Error("ClaudeEngineAdapter.compact requires sessionId");
    }
    if (!this.client.compact) {
      throw new Error("Claude client does not support compact");
    }
    await this.client.compact(sessionId);
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
    if (!this.client.deliverInputResponse) {
      return {
        status: "not_supported",
        message: "Claude client does not support input responses",
      };
    }

    const delivered = await this.client.deliverInputResponse(requestId, answers);
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
    await this.client.close?.();
  }

  private buildRunOptions(params: EngineExecuteParams): ClaudeRunOptions {
    const model = normalizeClaudeModel(params.model);
    return {
      prompt: params.prompt,
      workspaceDir: this.workspaceDir,
      ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
      ...(model ? { model } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
      ...(params.disallowedTools !== undefined ? { disallowedTools: params.disallowedTools } : {}),
      ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
      ...(params.useMcp !== undefined ? { useMcp: params.useMcp } : {}),
      env: buildClaudeEnvironment({
        processEnv: this.processEnv,
        extraEnv: params.extraEnv,
      }),
      ...(params.onIntervention ? { onIntervention: params.onIntervention } : {}),
    };
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
