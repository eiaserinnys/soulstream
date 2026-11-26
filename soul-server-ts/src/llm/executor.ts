import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import { buildSystemCallerInfo } from "../caller_info.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { TaskManager } from "../task/task_manager.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import {
  buildLlmUserMessageEvent,
  completeLlmTurn,
  enqueueLlmEvent,
  requireLlmAdapter,
  type LlmAdapters,
} from "./llm_turn.js";
import type { LlmCompletionRequest, LlmCompletionResponse } from "./types.js";

export interface LlmExecutorParams {
  adapters: LlmAdapters;
  taskManager: TaskManager;
  persistence: EventPersistence;
  broadcaster: SessionBroadcaster;
  nodeId: string;
  logger: Logger;
}

export class LlmExecutor {
  constructor(private readonly params: LlmExecutorParams) {}

  async execute(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const adapter = requireLlmAdapter(this.params.adapters, request.provider);

    const callerInfo = request.caller_info ?? buildSystemCallerInfo(this.params.nodeId);
    const task = await this.params.taskManager.createTask({
      agentSessionId: generateLlmSessionId(),
      prompt: request.messages.at(-1)?.content ?? "",
      clientId: request.client_id,
      sessionType: "llm",
      llmProvider: request.provider,
      llmModel: request.model,
      callerInfo,
    });

    await enqueueLlmEvent(
      this.params.persistence,
      task,
      buildLlmUserMessageEvent(request, callerInfo),
    );

    return await completeLlmTurn(this.params, task, adapter, request);
  }
}

function generateLlmSessionId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  return `llm-${timestamp}-${randomBytes(4).toString("hex")}`;
}
