import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { TaskManager } from "../task/task_manager.js";
import {
  LlmContinuationRejectedError,
  type LlmContinuation,
  type LlmContinuationTurn,
} from "../task/task_llm_continuation.js";
import type { InterventionMessage, Task } from "../task/task_models.js";

import {
  ProviderNotConfiguredError,
  completeLlmTurn,
  llmUserMessageFields,
  requireLlmAdapter,
  type LlmAdapters,
} from "./llm_turn.js";
import {
  LLM_DEFAULT_MAX_TOKENS,
  LlmMessageSchema,
  LlmProviderSchema,
  type LlmCompletionRequest,
  type LlmMessage,
} from "./types.js";

/** 가장 최근 user_message와 그 뒤 assistant_message를 찾기에 충분한 최신 이벤트 수. */
const HISTORY_SCAN_LIMIT = 50;

export interface LlmContinuationParams {
  adapters: LlmAdapters;
  db: Pick<SessionDB, "readEvents">;
  persistence: EventPersistence;
  taskManager: Pick<TaskManager, "finalizeTask">;
  logger: Logger;
}

interface HistoryEvent {
  id: number;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * 끝난 llm 세션에 글을 더 보내면 같은 세션에 user_message와 assistant_message를 붙인다.
 * 이력과 모델은 그 세션의 이벤트에서 읽고, 어댑터는 이 노드의 것을 쓴다.
 */
export class LlmSessionContinuation implements LlmContinuation {
  private readonly inFlight = new Set<string>();

  constructor(private readonly params: LlmContinuationParams) {}

  async prepare(task: Task, message: InterventionMessage): Promise<LlmContinuationTurn> {
    if (this.inFlight.has(task.agentSessionId)) {
      throw new LlmContinuationRejectedError(
        "이 llm 세션이 아직 답하는 중입니다. 답이 끝난 뒤에 다시 보내 주세요.",
      );
    }
    if (
      (message.attachmentIds?.length ?? 0) > 0
      || (message.attachmentPaths?.length ?? 0) > 0
    ) {
      throw new LlmContinuationRejectedError(
        "llm 세션은 첨부를 받지 않습니다. 첨부를 빼고 글만 보내 주세요.",
      );
    }

    const request = await this.buildRequest(task, message);
    let adapter;
    try {
      adapter = requireLlmAdapter(this.params.adapters, request.provider);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new LlmContinuationRejectedError(
          `이 노드에 ${request.provider} 키가 없어 이어 쓸 수 없습니다.`,
        );
      }
      throw err;
    }

    return {
      userMessageFields: llmUserMessageFields(request),
      run: async () => {
        this.inFlight.add(task.agentSessionId);
        try {
          await completeLlmTurn(this.params, task, adapter, request);
        } catch {
          // completeLlmTurn이 error 이벤트와 마감을 남기고 로그까지 찍었다.
        } finally {
          this.inFlight.delete(task.agentSessionId);
        }
      },
    };
  }

  private async buildRequest(
    task: Task,
    message: InterventionMessage,
  ): Promise<LlmCompletionRequest> {
    const events = (await this.params.db.readEvents(
      task.agentSessionId,
      0,
      HISTORY_SCAN_LIMIT,
      ["user_message", "assistant_message"],
      undefined,
      undefined,
      "desc",
    )) as HistoryEvent[];

    const lastUser = events.find((event) => event.event_type === "user_message");
    const lastAssistant = events.find((event) => event.event_type === "assistant_message");
    const assistantAfterUser = lastUser && lastAssistant && lastAssistant.id > lastUser.id
      ? lastAssistant
      : undefined;

    const provider = LlmProviderSchema.safeParse(
      lastAssistant?.payload.provider ?? lastUser?.payload.provider,
    );
    const model = firstNonEmptyString(lastAssistant?.payload.model, lastUser?.payload.model);
    if (!provider.success || model === undefined) {
      throw new LlmContinuationRejectedError(
        "이 llm 세션의 모델 정보를 찾지 못해 이어 쓸 수 없습니다. 새 세션에서 다시 물어 주세요.",
      );
    }

    const history = parseHistory(lastUser?.payload.messages);
    if (!lastUser || history === undefined) {
      throw new LlmContinuationRejectedError(
        "이 llm 세션의 대화 이력을 찾지 못해 이어 쓸 수 없습니다. 새 세션에서 다시 물어 주세요.",
      );
    }
    const answer = assistantAfterUser?.payload.content;
    const messages: LlmMessage[] = [
      ...history,
      ...(typeof answer === "string" ? [{ role: "assistant" as const, content: answer }] : []),
      { role: "user", content: message.text },
    ];

    return {
      provider: provider.data,
      model,
      messages,
      max_tokens: positiveInteger(lastUser.payload.max_tokens) ?? LLM_DEFAULT_MAX_TOKENS,
      temperature: typeof lastUser.payload.temperature === "number"
        ? lastUser.payload.temperature
        : null,
      client_id: firstNonEmptyString(lastUser.payload.client_id) ?? null,
      caller_info: message.callerInfo ?? task.callerInfo ?? null,
    };
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value !== "");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parseHistory(value: unknown): LlmMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parsed: LlmMessage[] = [];
  for (const item of value) {
    const message = LlmMessageSchema.safeParse(item);
    if (!message.success) return undefined;
    parsed.push(message.data);
  }
  return parsed;
}
