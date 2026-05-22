import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import { buildSystemCallerInfo } from "../caller_info.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { TaskManager } from "../task/task_manager.js";
import type { Task } from "../task/task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type {
  LlmAdapter,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProvider,
  LlmResult,
} from "./types.js";

export class ProviderNotConfiguredError extends Error {
  constructor(provider: LlmProvider) {
    super(
      `Provider '${provider}' is not configured. Set LLM_${provider.toUpperCase()}_API_KEY environment variable.`,
    );
    this.name = "ProviderNotConfiguredError";
  }
}

export interface LlmExecutorParams {
  adapters: Partial<Record<LlmProvider, LlmAdapter>>;
  taskManager: TaskManager;
  persistence: EventPersistence;
  broadcaster: SessionBroadcaster;
  nodeId: string;
  logger: Logger;
}

export class LlmExecutor {
  constructor(private readonly params: LlmExecutorParams) {}

  async execute(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const adapter = this.params.adapters[request.provider];
    if (!adapter) {
      throw new ProviderNotConfiguredError(request.provider);
    }

    const agentSessionId = generateLlmSessionId();
    const callerInfo = request.caller_info ?? buildSystemCallerInfo(this.params.nodeId);
    const task = await this.params.taskManager.createTask({
      agentSessionId,
      prompt: request.messages.at(-1)?.content ?? "",
      clientId: request.client_id,
      sessionType: "llm",
      llmProvider: request.provider,
      llmModel: request.model,
      callerInfo,
    });

    await this.persistAndBroadcast(task, {
      type: "user_message",
      timestamp: Date.now() / 1000,
      user: request.client_id ?? "llm",
      text: request.messages.at(-1)?.content ?? "",
      messages: request.messages,
      provider: request.provider,
      model: request.model,
      max_tokens: request.max_tokens,
      client_id: request.client_id,
      caller_info: callerInfo,
    });

    try {
      const result = await adapter.complete({
        model: request.model,
        messages: request.messages,
        maxTokens: request.max_tokens,
        temperature: request.temperature,
      });
      const usage = toUsage(result);

      await this.persistAndBroadcast(task, {
        type: "assistant_message",
        timestamp: Date.now() / 1000,
        content: result.content,
        usage,
        model: request.model,
        provider: request.provider,
      });

      await this.params.taskManager.finalizeTask({
        agentSessionId,
        result: result.content,
        llmUsage: usage,
      });

      this.params.logger.info(
        {
          sessionId: agentSessionId,
          provider: request.provider,
          model: request.model,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        },
        "LLM completion finished",
      );

      return {
        session_id: agentSessionId,
        content: result.content,
        usage,
        model: request.model,
        provider: request.provider,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.persistAndBroadcast(task, {
        type: "error",
        timestamp: Date.now() / 1000,
        message,
        provider: request.provider,
        model: request.model,
      });
      await this.params.taskManager.finalizeTask({
        agentSessionId,
        error: message,
      });
      this.params.logger.error(
        { err, sessionId: agentSessionId, provider: request.provider, model: request.model },
        "LLM completion failed",
      );
      throw err;
    }
  }

  private async persistAndBroadcast(
    task: Task,
    event: Record<string, unknown>,
  ): Promise<void> {
    const eventId = await this.params.persistence.persistEvent(
      task.agentSessionId,
      event as SSEEventPayload,
    );
    task.lastEventId = eventId;
    event._event_id = eventId;
    await this.params.persistence.handleSideEffects(
      task.agentSessionId,
      event as SSEEventPayload,
      task,
    );
    try {
      await this.params.broadcaster.emitEventEnvelope(
        task.agentSessionId,
        event as SSEEventPayload,
      );
    } catch (err) {
      this.params.logger.warn(
        { err, sessionId: task.agentSessionId, eventType: event.type },
        "LLM event broadcast failed",
      );
    }
  }
}

function generateLlmSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `llm-${timestamp}-${randomBytes(4).toString("hex")}`;
}

function toUsage(result: LlmResult): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
  };
}
