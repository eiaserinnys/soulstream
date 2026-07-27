import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { Env } from "../config.js";
import { AgentsEngineAdapter } from "../engine/agents_adapter.js";
import { ClaudeEngineAdapter } from "../engine/claude_adapter.js";
import type { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import { CodexEngineAdapter } from "../engine/codex_adapter.js";
import { CodexAppServerEngineAdapter } from "../engine/codex_app_server/index.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import type { EngineFactory } from "../task/task_executor.js";

type EngineFactoryEnv = Pick<
  Env,
  "CODEX_ADAPTER_MODE" | "CODEX_API_KEY" | "CLAUDE_SESSION_RUNTIME_V2_ENABLED"
>;

export interface CreateEngineFactoryParams {
  env: EngineFactoryEnv;
  logger: Logger;
  codexCliPath?: CodexCliPathResolution;
  codexProcessEnv: NodeJS.ProcessEnv;
  buildClaudeProcessEnv(): Record<string, string | undefined>;
  claudeSessionStore: SessionStore;
  claudeSessionClientRegistry?: ClaudeSessionClientRegistry;
}

export function createEngineFactory(params: CreateEngineFactoryParams): EngineFactory {
  const {
    env,
    logger,
    codexCliPath,
    codexProcessEnv,
    buildClaudeProcessEnv,
    claudeSessionStore,
    claudeSessionClientRegistry,
  } = params;

  return (agent) => {
    if (agent.backend === "codex") {
      if (env.CODEX_ADAPTER_MODE === "app-server") {
        return new CodexAppServerEngineAdapter(
          {
            workspaceDir: agent.workspace_dir,
            agentId: agent.id,
            apiKey: env.CODEX_API_KEY,
            codexPathOverride: codexCliPath?.path,
            processEnv: codexProcessEnv,
          },
          logger,
        );
      }
      return new CodexEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          agentId: agent.id,
          apiKey: env.CODEX_API_KEY,
          processEnv: codexProcessEnv,
          codexPathOverride: codexCliPath?.path,
        },
        logger,
      );
    }
    if (agent.backend === "claude") {
      return new ClaudeEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          agentId: agent.id,
          processEnv: buildClaudeProcessEnv(),
          sessionStore: claudeSessionStore,
          // V2 uses the shared transcript as its cross-node receiver receipt.
          sessionStoreFlush: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED ? "eager" : "batched",
          loadTimeoutMs: 60_000,
          ...(claudeSessionClientRegistry
            ? { persistentSessionRegistry: claudeSessionClientRegistry }
            : {}),
        },
        logger,
      );
    }
    if (agent.backend === "openai-agents") {
      return new AgentsEngineAdapter(
        { workspaceDir: agent.workspace_dir, profile: agent },
        logger,
      );
    }
    throw new Error(
      `Unsupported backend "${agent.backend}" in soul-server-ts (agent=${agent.id})`,
    );
  };
}
