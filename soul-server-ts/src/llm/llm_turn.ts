import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { TaskManager } from "../task/task_manager.js";
import type { CallerInfo, Task } from "../task/task_models.js";

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

export type LlmAdapters = Partial<Record<LlmProvider, LlmAdapter>>;

export function requireLlmAdapter(adapters: LlmAdapters, provider: LlmProvider): LlmAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new ProviderNotConfiguredError(provider);
  return adapter;
}

export interface LlmTurnDeps {
  persistence: EventPersistence;
  taskManager: Pick<TaskManager, "finalizeTask">;
  logger: Logger;
}

/** user_message에 실리는 llm 필드. 다음 이어 쓰기는 마지막 user_message 하나로 전체 이력을 얻는다. */
export function llmUserMessageFields(request: LlmCompletionRequest): Record<string, unknown> {
  return {
    messages: request.messages,
    provider: request.provider,
    model: request.model,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    client_id: request.client_id,
  };
}

export function buildLlmUserMessageEvent(
  request: LlmCompletionRequest,
  callerInfo: CallerInfo,
): Record<string, unknown> {
  return {
    type: "user_message",
    timestamp: Date.now() / 1000,
    user: request.client_id ?? "llm",
    text: request.messages.at(-1)?.content ?? "",
    ...llmUserMessageFields(request),
    caller_info: callerInfo,
  };
}

export async function enqueueLlmEvent(
  persistence: EventPersistence,
  task: Task,
  event: Record<string, unknown>,
): Promise<void> {
  const registrationId = task.executionRegistration?.registrationId;
  if (registrationId === undefined) {
    await persistence.enqueueEvent(task.agentSessionId, event as SSEEventPayload);
  } else {
    await persistence.enqueueEvent(
      task.agentSessionId,
      event as SSEEventPayload,
      undefined,
      registrationId,
    );
  }
  await persistence.handleSideEffects(task.agentSessionId, event as SSEEventPayload, task);
}

/**
 * 어댑터를 부르고 답(또는 오류)을 기록한 뒤 세션을 끝낸다. 새 llm 세션과 끝난 세션의
 * 이어 쓰기가 함께 쓴다. 오류는 error 이벤트와 error 마감을 남긴 뒤 다시 던진다.
 */
export async function completeLlmTurn(
  deps: LlmTurnDeps,
  task: Task,
  adapter: LlmAdapter,
  request: LlmCompletionRequest,
): Promise<LlmCompletionResponse> {
  const agentSessionId = task.agentSessionId;
  try {
    const result = await adapter.complete({
      model: request.model,
      messages: request.messages,
      maxTokens: request.max_tokens,
      temperature: request.temperature,
    });
    const usage = toUsage(result);

    await enqueueLlmEvent(deps.persistence, task, {
      type: "assistant_message",
      timestamp: Date.now() / 1000,
      content: result.content,
      usage,
      model: request.model,
      provider: request.provider,
    });

    await deps.taskManager.finalizeTask({
      agentSessionId,
      result: result.content,
      llmUsage: usage,
    });

    deps.logger.info(
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
    await enqueueLlmEvent(deps.persistence, task, {
      type: "error",
      timestamp: Date.now() / 1000,
      message,
      provider: request.provider,
      model: request.model,
    });
    await deps.taskManager.finalizeTask({ agentSessionId, error: message });
    deps.logger.error(
      { err, sessionId: agentSessionId, provider: request.provider, model: request.model },
      "LLM completion failed",
    );
    throw err;
  }
}

function toUsage(result: LlmResult): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
  };
}
