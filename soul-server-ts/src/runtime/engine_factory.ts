import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { Env } from "../config.js";
import { AntigravityEngineAdapter } from "../engine/antigravity/adapter.js";
import type { AntigravityCliPathResolution } from "../engine/antigravity_cli_path.js";
import { OpenCodeEngineAdapter } from "../engine/opencode/adapter.js";
import { AgentsEngineAdapter } from "../engine/agents_adapter.js";
import { ClaudeEngineAdapter } from "../engine/claude_adapter.js";
import type { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import type { ClaudeAccountTurnPort } from "../engine/claude_account_pool.js";
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
  | "CODEX_APP_SERVER_REQUEST_TIMEOUT_MS"
  | "CODEX_APP_SERVER_STARTUP_TIMEOUT_MS"
  | "CODEX_DETACHED_RESULT_RETENTION_MS"
  | "CLAUDE_SESSION_RUNTIME_V2_ENABLED"
  | "CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS"
  | "CLAUDE_SESSION_RUNTIME_MAX_ENTRIES"
  | "CLAUDE_ACCOUNT_POOL_ENABLED"
  | "MCP_INTERNAL_PORT"
  | "MCP_PATH"
  | "SOUL_RUNNER_STATE_DIR"
> & Partial<Pick<Env, "OPENCODE_CLI_PATH">>;

export interface CreateEngineFactoryParams {
  env: EngineFactoryEnv;
  logger: Logger;
  codexCliPath?: CodexCliPathResolution;
  antigravityCliPath?: AntigravityCliPathResolution;
  antigravityProcessEnv: NodeJS.ProcessEnv;
  codexProcessEnv: NodeJS.ProcessEnv;
  buildClaudeProcessEnv(): Record<string, string | undefined>;
  claudeSessionStore: SessionStore;
  claudeSessionClientRegistry?: ClaudeSessionClientRegistry;
  claudeAccountTurnPort?: ClaudeAccountTurnPort;
  mcpConfigService: McpConfigService;
}

export function createEngineFactory(params: CreateEngineFactoryParams): EngineFactory {
  const {
    env,
    logger,
    codexCliPath,
    antigravityCliPath,
    antigravityProcessEnv,
    codexProcessEnv,
    buildClaudeProcessEnv,
    claudeSessionStore,
    claudeSessionClientRegistry,
    claudeAccountTurnPort,
    mcpConfigService,
  } = params;

  return (agent, backendOverride) => {
    const backend = backendOverride ?? agent.backend;
    if (backend === "antigravity") {
      return new AntigravityEngineAdapter({
        workspaceDir: agent.workspace_dir,
        agentId: agent.id,
        stateDirectory: env.SOUL_RUNNER_STATE_DIR,
        executablePath: antigravityCliPath?.path,
        processEnv: antigravityProcessEnv,
        resolvedMcpServers: mcpConfigService.resolveMcpProfile(agent)?.mcp_servers,
        internalMcpUrl: localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH),
      }, logger);
    }
    if (backend === "opencode") {
      return new OpenCodeEngineAdapter({
        workspaceDir: agent.workspace_dir,
        agentId: agent.id,
        stateDirectory: env.SOUL_RUNNER_STATE_DIR,
        executablePath: env.OPENCODE_CLI_PATH,
        processEnv: process.env,
        resolvedMcpServers: mcpConfigService.resolveMcpProfile(agent)?.mcp_servers,
        internalMcpUrl: localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH),
      }, logger);
    }
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
            requestTimeoutMs: env.CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
            startupRequestTimeoutMs: env.CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
            codexDetachedResultRetentionMs: env.CODEX_DETACHED_RESULT_RETENTION_MS,
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
          sessionStoreFlush: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED || env.CLAUDE_ACCOUNT_POOL_ENABLED
            ? "eager"
            : "batched",
          loadTimeoutMs: 60_000,
          trackChildExit: env.CLAUDE_ACCOUNT_POOL_ENABLED,
          claudeAccountPoolEnabled: env.CLAUDE_ACCOUNT_POOL_ENABLED,
          ...(claudeAccountTurnPort ? { claudeAccountTurnPort } : {}),
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
