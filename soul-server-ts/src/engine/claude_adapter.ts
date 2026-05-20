import type { Logger } from "pino";

import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "./protocol.js";
import {
  mapClaudeClientEvent,
  type ClaudeClientEvent,
} from "./claude_event_mapper.js";
import {
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";

export {
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_PROMPT_SUGGESTION_ENV,
  buildClaudeEnvironment,
  normalizeClaudeModel,
} from "./claude_options.js";
export type { ClaudeClientEvent } from "./claude_event_mapper.js";

export interface ClaudeRunOptions {
  prompt: string;
  workspaceDir: string;
  resumeSessionId?: string;
  model?: string;
  systemPrompt?: string;
  env: Record<string, string>;
}

export interface ClaudeClient {
  run(options: ClaudeRunOptions, signal: AbortSignal): AsyncIterable<ClaudeClientEvent>;
  interrupt?(): Promise<boolean>;
  close?(): Promise<void>;
}

export interface ClaudeAdapterConfig {
  workspaceDir: string;
  client?: ClaudeClient;
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export class ClaudeEngineAdapter implements EnginePort {
  public readonly backendId: BackendId = "claude";
  public readonly workspaceDir: string;

  private readonly client: ClaudeClient;
  private readonly logger: Logger;
  private readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  private currentTurn: AbortController | null = null;
  private closed = false;

  constructor(config: ClaudeAdapterConfig, logger: Logger) {
    this.workspaceDir = config.workspaceDir;
    this.client = config.client ?? new NotConfiguredClaudeClient();
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.currentTurn) {
      this.currentTurn.abort();
      this.currentTurn = null;
    }
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
      env: buildClaudeEnvironment({
        processEnv: this.processEnv,
        extraEnv: params.extraEnv,
      }),
    };
  }
}

class NotConfiguredClaudeClient implements ClaudeClient {
  async *run(): AsyncIterable<ClaudeClientEvent> {
    throw new Error(
      "ClaudeEngineAdapter requires an injected Claude client; real Claude CLI/SDK integration is not wired in P2",
    );
  }
}

class ClaudeClientFatalEventError extends Error {}

function nowSeconds(): number {
  return Date.now() / 1000;
}
