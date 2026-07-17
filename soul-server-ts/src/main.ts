import dotenv from "dotenv";
import { ZodError } from "zod";

import { loadAgentRegistry } from "./agent_registry.js";
import { parseEnv } from "./config.js";
import { resolveCodexCliPath } from "./engine/codex_cli_path.js";
import { createLogger } from "./logger.js";
import { McpConfigService } from "./mcp_config_service.js";
import { composeWorkerRuntime } from "./runtime/worker_composition.js";
import { startServer } from "./server.js";
import {
  startConfiguredSupervisors,
  validateConfiguredSupervisors,
} from "./supervisor/activation.js";

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

  const logger = createLogger(env.LOG_LEVEL);
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
    },
    "soul-server-ts starting (B-3 task lifecycle + DB)",
  );

  const hasClaudeBackend = agentRegistry.supportedBackends().includes("claude");
  const hasCodexBackend = agentRegistry.supportedBackends().includes("codex");
  const supervisorActivationConfig = {
    enabled: env.SUPERVISOR_ENABLED,
    roles: env.SUPERVISOR_ROLES,
    folderId: env.SUPERVISOR_FOLDER_ID,
  };
  try {
    validateConfiguredSupervisors(supervisorActivationConfig, agentRegistry);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Supervisor startup validation failed: ${message}`);
    process.exit(1);
  }
  if (hasClaudeBackend && !env.CLAUDE_AUTH_TOKEN_PATH) {
    console.error(
      "CLAUDE_AUTH_TOKEN_PATH is required when agents.yaml contains a Claude backend agent.",
    );
    console.error(
      "TS Claude auth storage must be explicit; Python .env and ~/.claude are not shared.",
    );
    process.exit(1);
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

  const runtime = await composeWorkerRuntime({
    env,
    logger,
    agentRegistry,
    mcpConfigService,
    codexCliPath,
  });
  await startServer(runtime.server, env.HOST, env.PORT);
  logger.info(
    {
      host: env.HOST,
      port: env.PORT,
      mcpEnabled: env.MCP_ENABLED,
      mcpPath: env.MCP_ENABLED ? env.MCP_PATH : undefined,
    },
    "HTTP listening",
  );

  const upstreamAdapter = runtime.createUpstreamAdapter();
  upstreamAdapter.run().catch((err) => {
    logger.fatal({ err }, "Upstream adapter terminated unexpectedly");
    process.exit(1);
  });

  if (env.SUPERVISOR_ENABLED) {
    try {
      const supervisorActivation = await startConfiguredSupervisors({
        config: supervisorActivationConfig,
        agentRegistry,
        db: runtime.db,
        taskManager: runtime.taskManager,
        taskExecutor: runtime.taskExecutor,
        logger,
      });
      for (const result of supervisorActivation) {
        if (!result.role || result.status === "disabled") continue;
        runtime.supervisorWakeScheduler?.markSnapshotPending(result.role);
        try {
          await runtime.supervisorWakeScheduler?.flush(result.role);
        } catch (err) {
          logger.warn({ err, role: result.role }, "Supervisor cold-start snapshot wake failed");
        }
      }
      logger.info({ supervisorActivation }, "Supervisor activation completed");
    } catch (err) {
      logger.fatal({ err }, "Supervisor activation failed");
      process.exit(1);
    }
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    if (runtime.supervisorWatchdogInterval) {
      clearInterval(runtime.supervisorWatchdogInterval);
    }
    runtime.supervisorWakeScheduler?.dispose();
    runtime.sessionPageBindingService.stop();
    runtime.checklistRunbookReconciler.stop();
    try {
      runtime.scheduleDispatcher.stop();
      await runtime.taskExecutor.failScheduledClaudeRuntimeFollowupsForShutdown();
      await runtime.taskManager.shutdown();
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
    await runtime.server.close();
    try {
      await runtime.db.close();
    } catch (err) {
      logger.warn({ err }, "DB close failed");
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
