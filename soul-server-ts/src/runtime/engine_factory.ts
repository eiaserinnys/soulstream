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
import type { McpConfigService } from "../mcp_config_service.js";
import { localInternalMcpUrl } from "../mcp/endpoint_paths.js";
import type { EngineFactory } from "../task/task_executor.js";

type EngineFactoryEnv = Pick<
  Env,
  | "CODEX_ADAPTER_MODE"
  | "CODEX_API_KEY"
  | "CLAUDE_SESSION_RUNTIME_V2_ENABLED"
  | "MCP_INTERNAL_PORT"
  | "MCP_PATH"
>;

export interface CreateEngineFactoryParams {
  env: EngineFactoryEnv;
  logger: Logger;
  codexCliPath?: CodexCliPathResolution;
  codexProcessEnv: NodeJS.ProcessEnv;
  buildClaudeProcessEnv(): Record<string, string | undefined>;
  claudeSessionStore: SessionStore;
  claudeSessionClientRegistry?: ClaudeSessionClientRegistry;
  mcpConfigService: McpConfigService;
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
    mcpConfigService,
  } = params;

  return (agent, backendOverride) => {
    const backend = backendOverride ?? agent.backend;
    if (backend === "codex") {
      const resolvedMcpServers =
        mcpConfigService.resolveMcpProfile(agent)?.mcp_servers;
      if (env.CODEX_ADAPTER_MODE === "app-server") {
        return new CodexAppServerEngineAdapter(
          {
            workspaceDir: agent.workspace_dir,
            agentId: agent.id,
            apiKey: env.CODEX_API_KEY,
            codexPathOverride: codexCliPath?.path,
            processEnv: codexProcessEnv,
            internalMcpUrl: localInternalMcpUrl(
              env.MCP_INTERNAL_PORT,
              env.MCP_PATH,
            ),
            ...(resolvedMcpServers !== undefined
              ? { resolvedMcpServers }
              : {}),
          },
          logger,
        );
      }
      if (resolvedMcpServers !== undefined) {
        throw new Error(
          `Codex agent ${agent.id} with mcp_profile requires CODEX_ADAPTER_MODE=app-server`,
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
    if (backend === "claude") {
      const resolvedMcpServers =
        mcpConfigService.resolveMcpProfile(agent)?.mcp_servers;
      return new ClaudeEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          agentId: agent.id,
          processEnv: buildClaudeProcessEnv(),
          sessionStore: claudeSessionStore,
          // V2 uses the shared transcript as its cross-node receiver receipt.
          sessionStoreFlush: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED ? "eager" : "batched",
          loadTimeoutMs: 60_000,
          internalMcpUrl: localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH),
          ...(resolvedMcpServers !== undefined
            ? { resolvedMcpServers }
            : {}),
          ...(claudeSessionClientRegistry
            ? { persistentSessionRegistry: claudeSessionClientRegistry }
            : {}),
        },
        logger,
      );
    }
    if (backend === "openai-agents") {
      return new AgentsEngineAdapter(
        { workspaceDir: agent.workspace_dir, profile: agent },
        logger,
      );
    }
    throw new Error(
      `Unsupported backend "${backend}" in soul-server-ts (agent=${agent.id})`,
    );
  };
}
