import type { Logger } from "pino";

import type { Env } from "../config.js";
import { AntigravityEngineAdapter } from "../engine/antigravity/adapter.js";
import { OpenCodeEngineAdapter } from "../engine/opencode/adapter.js";
import { ClaudeEngineAdapter } from "../engine/claude_adapter.js";
import type { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import type { ClaudeAccountTurnPort } from "../engine/claude_account_pool.js";
import { CodexEngineAdapter } from "../engine/codex_adapter.js";
import { CodexAppServerEngineAdapter } from "../engine/codex_app_server/index.js";
import type { AntigravityCliPathResolution, CodexCliPathResolution } from "@soulstream/executable-path";
import type { McpConfigService, ResolvedMcpServer } from "../mcp_config_service.js";
import { localInternalMcpUrl } from "../mcp/endpoint_paths.js";
import { withFullSessionCredential } from "../runner/full_session_credential.js";
import type { EngineFactory } from "../task/task_executor.js";
import type { ModelCatalogConfig } from "@soulstream/model-catalog";

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
  /**
   * 호스트 `AUTH_BEARER_TOKEN`. in-process full 세션의 엔진 env와 soulstream
   * 내부 MCP 자격을 그 세션의 ssf1로 바꿀 때 쓴다. 비면 변환하지 않는다.
   */
  hostAuthBearerToken?: string;
  claudeSessionClientRegistry?: ClaudeSessionClientRegistry;
  claudeAccountTurnPort?: ClaudeAccountTurnPort;
  mcpConfigService: McpConfigService;
  /** Latest catalogue snapshot; adapters resolve it once per terminal event. */
  getModelCatalog: () => ModelCatalogConfig;
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
    claudeSessionClientRegistry,
    claudeAccountTurnPort,
    mcpConfigService,
    getModelCatalog,
    hostAuthBearerToken,
  } = params;

  return (agent, backendOverride, agentSessionId) => {
    const backend = backendOverride ?? agent.backend;
    /**
     * in-process 경로는 restricted 판정에서 내려오지 않으므로 여기서 만드는
     * 엔진은 모두 full 세션이다. 러너 경로와 같은 변환 함수로 엔진에 넘기는
     * child env와 soulstream 내부 대상 MCP `Authorization`을 그 세션의 ssf1로
     * 바꾼다.
     */
    const credentialedInput = (
      processEnv: NodeJS.ProcessEnv,
      servers: ResolvedMcpServer[] | undefined,
    ): { processEnv: NodeJS.ProcessEnv; servers: ResolvedMcpServer[] | undefined } => {
      if (!agentSessionId) return { processEnv, servers };
      const transformed = withFullSessionCredential(
        {
          sessionId: agentSessionId,
          childProcessEnv: processEnv,
          ...(servers !== undefined ? { resolvedMcpServers: servers } : {}),
        },
        { hostBearerToken: hostAuthBearerToken },
      );
      return {
        processEnv: transformed.childProcessEnv ?? processEnv,
        servers: transformed.resolvedMcpServers ?? servers,
      };
    };
    if (backend === "antigravity") {
      const input = credentialedInput(
        antigravityProcessEnv,
        mcpConfigService.resolveMcpProfile(agent)?.mcp_servers,
      );
      return new AntigravityEngineAdapter({
        workspaceDir: agent.workspace_dir,
        agentId: agent.id,
        stateDirectory: env.SOUL_RUNNER_STATE_DIR,
        executablePath: antigravityCliPath?.path,
        processEnv: input.processEnv,
        resolvedMcpServers: input.servers,
        internalMcpUrl: localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH),
        ...(agent.allowed_tools ? { allowedTools: agent.allowed_tools } : {}),
        ...(agent.disallowed_tools ? { disallowedTools: agent.disallowed_tools } : {}),
        ...(agent.claude_permission_mode ? { claudePermissionMode: agent.claude_permission_mode } : {}),
        profileWorkspaceDir: agent.workspace_dir,
        getModelCatalog,
      }, logger);
    }
    if (backend === "opencode") {
      const input = credentialedInput(
        process.env,
        mcpConfigService.resolveMcpProfile(agent)?.mcp_servers,
      );
      return new OpenCodeEngineAdapter({
        workspaceDir: agent.workspace_dir,
        agentId: agent.id,
        stateDirectory: env.SOUL_RUNNER_STATE_DIR,
        executablePath: env.OPENCODE_CLI_PATH,
        processEnv: input.processEnv,
        resolvedMcpServers: input.servers,
        internalMcpUrl: localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH),
      }, logger);
    }
    if (backend === "codex") {
      const input = credentialedInput(
        codexProcessEnv,
        mcpConfigService.resolveMcpProfile(agent)?.mcp_servers,
      );
      const resolvedMcpServers = input.servers;
      if (env.CODEX_ADAPTER_MODE === "app-server") {
        return new CodexAppServerEngineAdapter(
          {
            workspaceDir: agent.workspace_dir,
            agentId: agent.id,
            apiKey: env.CODEX_API_KEY,
            codexPathOverride: codexCliPath?.path,
            processEnv: input.processEnv,
            requestTimeoutMs: env.CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
            startupRequestTimeoutMs: env.CODEX_APP_SERVER_STARTUP_TIMEOUT_MS,
            codexDetachedResultRetentionMs: env.CODEX_DETACHED_RESULT_RETENTION_MS,
            internalMcpUrl: localInternalMcpUrl(
              env.MCP_INTERNAL_PORT,
              env.MCP_PATH,
            ),
            getModelCatalog,
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
          processEnv: input.processEnv,
          codexPathOverride: codexCliPath?.path,
        },
        logger,
      );
    }
    if (backend === "claude") {
      const input = credentialedInput(
        buildClaudeProcessEnv(),
        mcpConfigService.resolveMcpProfile(agent)?.mcp_servers,
      );
      const resolvedMcpServers = input.servers;
      return new ClaudeEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          agentId: agent.id,
          processEnv: input.processEnv,
          trackChildExit: env.CLAUDE_ACCOUNT_POOL_ENABLED,
          claudeAccountPoolEnabled: env.CLAUDE_ACCOUNT_POOL_ENABLED,
          ...(claudeAccountTurnPort ? { claudeAccountTurnPort } : {}),
          internalMcpUrl: localInternalMcpUrl(env.MCP_INTERNAL_PORT, env.MCP_PATH),
          getModelCatalog,
          ...(resolvedMcpServers !== undefined
            ? { resolvedMcpServers }
            : {}),
          ...(claudeSessionClientRegistry
            ? { persistentSessionRegistry: claudeSessionClientRegistry }
            : {}),
          ...(env.SOUL_RUNNER_STATE_DIR
            ? { stateDirectory: env.SOUL_RUNNER_STATE_DIR }
            : {}),
        },
        logger,
      );
    }
    throw new Error(
      `Unsupported backend "${backend}" in soul-server-ts (agent=${agent.id})`,
    );
  };
}
