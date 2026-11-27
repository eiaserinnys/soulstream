import type { Logger } from "pino";

import type { Env } from "../config.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { TaskManager } from "../task/task_manager.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import { AnthropicAdapter, OpenAIAdapter } from "./adapters.js";
import { LlmExecutor } from "./executor.js";
import type { LlmRouteConfig } from "./router.js";

export interface LlmCompositionParams {
  env: Env;
  taskManager: TaskManager;
  persistence: EventPersistence;
  broadcaster: SessionBroadcaster;
  logger: Logger;
}

export function composeLlmRoute(params: LlmCompositionParams): LlmRouteConfig | undefined {
  const { env, taskManager, persistence, broadcaster, logger } = params;
  const adapters = {
    ...(env.LLM_OPENAI_API_KEY ? { openai: new OpenAIAdapter(env.LLM_OPENAI_API_KEY) } : {}),
    ...(env.LLM_ANTHROPIC_API_KEY
      ? { anthropic: new AnthropicAdapter(env.LLM_ANTHROPIC_API_KEY) }
      : {}),
  };
  if (Object.keys(adapters).length === 0) {
    logger.info("LLM proxy skipped: no provider API keys configured");
    return undefined;
  }
  logger.info({ providers: Object.keys(adapters) }, "LLM proxy initialized");
  return {
    executor: new LlmExecutor({
      adapters,
      taskManager,
      persistence,
      broadcaster,
      nodeId: env.SOULSTREAM_NODE_ID,
      logger,
    }),
    authBearerToken: env.AUTH_BEARER_TOKEN,
    isProduction: env.ENVIRONMENT === "production",
    logger,
  };
}
