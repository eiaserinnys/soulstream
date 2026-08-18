import dotenv from "dotenv";
import { ZodError } from "zod";

import { loadAgentRegistry } from "./agent_registry.js";
import { AgentProfileSource } from "./agent_profile_source.js";
import { parseEnv } from "./config.js";
import { configureClaudeExecutablePath } from "./engine/claude_executable_path.js";
import { resolveCodexCliPath } from "./engine/codex_cli_path.js";
import { createLogger } from "./logger.js";
import { McpConfigService } from "./mcp_config_service.js";
import { loadModelCatalog } from "./model_catalog.js";
import { composeWorkerRuntime } from "./runtime/worker_composition.js";
import { startWorkerRuntime } from "./runtime/worker_startup.js";
import { startNodeStallMonitor } from "./runtime/node_stall_monitor.js";
import { installProcessErrorHandlers } from "./runtime/process_error_handlers.js";
import { assertRunnerNodeRuntime } from "./runner/runner_node_runtime_preflight.js";
import { startInternalMcpServer, startServer } from "./server.js";
import { wsToHttpBase } from "./mcp/orch_proxy.js";

// Haniel cwd는 ./services/soulstream — install.configs.soul-server-ts-env path와 정합.
// legacy `.env`와 분리하여 SOULSTREAM_NODE_ID 충돌을 막는다.
const DOTENV_PATH = ".env.soul-server-ts";
const dotenvResult = dotenv.config({ path: DOTENV_PATH, override: true });
if (dotenvResult.error) {
  console.warn(
    `[soul-server-ts] dotenv: "${DOTENV_PATH}" not loaded from cwd=${process.cwd()}: ${dotenvResult.error.message}`,
  );
}

async function main(): Promise<void> {
  let env;
  try {
    env = parseEnv(process.env);
  } catch (err) {
    if (err instanceof ZodError) {
      console.error("Environment validation failed:");
      for (const issue of err.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      console.error("Environment parse threw:", err);
    }
    process.exit(1);
  }

  await assertRunnerNodeRuntime({
    runnerProcessEnabled: env.SOUL_RUNNER_PROCESS_ENABLED,
    nodeVersion: process.versions.node,
  });

  const logger = createLogger(env.LOG_LEVEL);
  installProcessErrorHandlers({ component: "soul-server", logger });
  const nodeStallMonitor = startNodeStallMonitor({ logger });
  let modelCatalog: ReturnType<typeof loadModelCatalog>;
  try {
    modelCatalog = loadModelCatalog(env.MODEL_CATALOG_PATH, logger);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to load model catalog from "${env.MODEL_CATALOG_PATH}": ${message}`,
    );
    console.error(
      "Hint: MODEL_CATALOG_PATH must point to a valid model catalog YAML file.",
    );
    process.exit(1);
  }
  const mcpConfigService = new McpConfigService({
    agentsConfigPath: env.AGENTS_CONFIG_PATH,
    processEnv: process.env,
  });
  let agentRegistry;
  try {
    agentRegistry = loadAgentRegistry(env.AGENTS_CONFIG_PATH, {
      profileResolver: (profiles) => mcpConfigService.resolveProfiles(profiles),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load agent registry from "${env.AGENTS_CONFIG_PATH}": ${message}`);
    console.error(
      "Hint: AGENTS_CONFIG_PATH env or Haniel install.configs.soul-server-ts-env may be missing.",
    );
    process.exit(1);
  }
  for (const profile of agentRegistry.list()) {
    if (profile.model) {
      logger.warn(
        { agentId: profile.id },
        "agent.model is deprecated; move the model to model-catalog.yaml and use default_preset",
      );
    }
    if (!profile.default_preset) {
      logger.warn(
        { agentId: profile.id, backend: profile.backend },
        "agent.backend still selects the default model path; configure default_preset",
      );
    }
  }
  const agentProfileSource = new AgentProfileSource({
    agentsConfigPath: env.AGENTS_CONFIG_PATH,
    cachePath: env.AGENT_PROFILE_CACHE_PATH,
    runtimeUrl: `${wsToHttpBase(env.SOULSTREAM_UPSTREAM_URL)}/api/agent-profiles/runtime`,
    headers: env.AUTH_BEARER_TOKEN
      ? { authorization: `Bearer ${env.AUTH_BEARER_TOKEN}` }
      : {},
    logger,
    profileResolver: (profiles) => mcpConfigService.resolveProfiles(profiles),
  });
  await agentProfileSource.initialize();

  logger.info(
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      upstreamUrl: env.SOULSTREAM_UPSTREAM_URL,
      environment: env.ENVIRONMENT,
      host: env.HOST,
      port: env.PORT,
      agentsConfigPath: env.AGENTS_CONFIG_PATH,
      agentCount: agentRegistry.list().length,
      claudeAuthTokenPathConfigured: Boolean(env.CLAUDE_AUTH_TOKEN_PATH),
      claudeSessionRuntimeV2Enabled: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
    },
    "soul-server-ts starting (orchestrator-hosted persistence)",
  );

  const hasClaudeBackend = agentRegistry.supportedBackends().includes("claude");
  const hasCodexBackend = agentRegistry.supportedBackends().includes("codex");
  if (hasClaudeBackend && !env.CLAUDE_AUTH_TOKEN_PATH) {
    console.error(
      "CLAUDE_AUTH_TOKEN_PATH is required when agents.yaml contains a Claude backend agent.",
    );
    console.error(
      "TS Claude auth storage must be explicit; Python .env and ~/.claude are not shared.",
    );
    process.exit(1);
  }
  if (hasClaudeBackend) {
    const claudeExecutablePath = configureClaudeExecutablePath(
      process.env,
      process.platform,
      logger,
    );
    logger.info(
      { path: claudeExecutablePath },
      "Claude Code executable path resolved",
    );
  }
  const codexCliPath = resolveCodexCliPath(process.env);
  if (hasCodexBackend) {
    if (codexCliPath) {
      logger.info(
        { source: codexCliPath.source, path: codexCliPath.path },
        "Codex CLI path resolved",
      );
    } else {
      logger.warn(
        "Codex CLI path not resolved from CODEX_CLI_PATH, PATH, or HOME. SDK mode will use the bundled binary; app-server mode will fall back to spawning \"codex\" from PATH.",
      );
    }
  }

  const { runtime, upstreamAdapter } = await startWorkerRuntime({
    compose: async () => await composeWorkerRuntime({
      env,
      logger,
      agentRegistry,
      mcpConfigService,
      codexCliPath,
      modelCatalog,
      agentProfileSource,
      nodeStallMonitor,
    }),
    listen: async (composed) => {
      if (composed.server.internalMcpServer) {
        await startInternalMcpServer(
          composed.server.internalMcpServer,
          env.MCP_INTERNAL_PORT,
        );
        logger.info(
          {
            host: "127.0.0.1",
            port: env.MCP_INTERNAL_PORT,
            path: `${env.MCP_PATH.replace(/\/+$/, "")}/internal`,
          },
          "Node-local internal MCP listening",
        );
      }
      await startServer(composed.server, env.HOST, env.PORT);
      logger.info(
        {
          host: env.HOST,
          port: env.PORT,
          mcpEnabled: env.MCP_ENABLED,
          mcpPath: env.MCP_ENABLED ? env.MCP_PATH : undefined,
          mcpStatelessTransportEnabled: env.MCP_ENABLED
            ? env.MCP_STATELESS_TRANSPORT_ENABLED
            : undefined,
        },
        "HTTP listening",
      );
    },
    logger,
    onUpstreamFailure: (err) => {
      logger.fatal({ err }, "Upstream adapter terminated unexpectedly");
      process.exit(1);
    },
    onRunnerRecoveryFailure: (err) => {
      logger.fatal({ err }, "Runner recovery initial scan failed");
      process.exit(1);
    },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    if (runtime.claudeRuntimeStartupRecovery) {
      const startupRecoveryDrain =
        await runtime.claudeRuntimeStartupRecovery.stop(5_000);
      logger.info(
        { outcome: startupRecoveryDrain },
        "Claude runtime startup recovery shutdown drain finished",
      );
    }
    if (runtime.completionDeliveryRecoveryWorker) {
      const deliveryDrain =
        await runtime.completionDeliveryRecoveryWorker.stop(5_000);
      logger.info(
        { outcome: deliveryDrain },
        "Completion delivery recovery shutdown drain finished",
      );
    }
    runtime.sessionPageBindingService.stop();
    runtime.checklistTaskReconciler.stop();
    await runtime.runnerRecoveryCoordinator?.stop();
    try {
      runtime.scheduleDispatcher.stop();
      await runtime.taskExecutor.failScheduledClaudeRuntimeFollowupsForShutdown();
      await runtime.taskManager.shutdown();
      if (runtime.claudeSessionClientRegistry) {
        await runtime.claudeSessionClientRegistry.shutdown();
      }
    } catch (err) {
      logger.warn({ err }, "TaskManager shutdown failed");
    }
    await upstreamAdapter.shutdown();
    if (runtime.server.closeMcp) {
      try {
        await runtime.server.closeMcp();
      } catch (err) {
        logger.warn({ err }, "MCP transports close failed");
      }
    }
    if (runtime.server.internalMcpServer) {
      await runtime.server.internalMcpServer.close();
    }
    await runtime.server.close();
    await runtime.runnerStateHostOwnership?.release();
    await nodeStallMonitor.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
