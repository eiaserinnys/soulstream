import { readFile } from "node:fs/promises";

import pino from "pino";

import { installProcessErrorHandlers } from "../runtime/process_error_handlers.js";
import { parseAntigravityMcpProxyConfig, runAntigravityMcpSchemaProxy } from "../engine/antigravity/mcp_schema_proxy.js";
import { parseAntigravityMcpGatewayConfig, runAntigravityMcpGateway } from "../engine/antigravity/mcp_gateway.js";
import { ANTIGRAVITY_MCP_GATEWAY_CONFIG_ENV, ANTIGRAVITY_MCP_GATEWAY_FLAG,
  ANTIGRAVITY_MCP_PROXY_CONFIG_ENV, ANTIGRAVITY_MCP_PROXY_FLAG } from "../engine/antigravity/mcp_schema_proxy_launch.js";
import { RunnerChildRuntime } from "./runner_child_runtime.js";
import { parseRunnerChildConfig } from "./runner_process_spawn.js";
import { startRunnerLogRotation } from "./runner_log_rotation.js";
import { readProcessStartIdentity } from "./runner_process_lock.js";

if (process.argv[2] === ANTIGRAVITY_MCP_PROXY_FLAG) await runAntigravityMcpProxyMode();
else if (process.argv[2] === ANTIGRAVITY_MCP_GATEWAY_FLAG) await runAntigravityMcpGatewayMode();
else await runSessionRunner();

async function runAntigravityMcpGatewayMode(): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let configParsed = false;
  try {
    const path = process.env[ANTIGRAVITY_MCP_GATEWAY_CONFIG_ENV];
    if (!path) throw new Error("Missing gateway configuration path");
    const upstreams = parseAntigravityMcpGatewayConfig(await readFile(path, "utf8"));
    configParsed = true;
    await runAntigravityMcpGateway(upstreams, {
      stdin: process.stdin, stdout: process.stdout, inheritedEnv: process.env, signal: controller.signal,
    });
  } catch {
    process.stderr.write(configParsed
      ? "Antigravity MCP gateway transport failed\n"
      : "Antigravity MCP gateway configuration failed\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

async function runAntigravityMcpProxyMode(): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let configParsed = false;
  try {
    const config = parseAntigravityMcpProxyConfig(process.env[ANTIGRAVITY_MCP_PROXY_CONFIG_ENV]);
    configParsed = true;
    await runAntigravityMcpSchemaProxy(config, {
      stdin: process.stdin,
      stdout: process.stdout,
      inheritedEnv: process.env,
      signal: controller.signal,
    });
  } catch {
    process.stderr.write(configParsed
      ? "Antigravity MCP proxy transport failed\n"
      : "Antigravity MCP proxy configuration failed\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

async function runSessionRunner(): Promise<void> {
  const configPath = readConfigArgument(process.argv.slice(2));
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const config = parseRunnerChildConfig(parsed);
  const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { component: "session-runner", sessionId: config.sessionId },
  });
  installProcessErrorHandlers({ component: "session-runner", logger });
  const stopLogRotation = startRunnerLogRotation(
    process.stdout.fd,
    config.paths.logPath,
    (error) => logger.error({ err: error }, "Runner log rotation failed"),
  );
  if (process.platform === "linux") {
    delete process.env.SOUL_RUNNER_OWNER;
    const identity = await readProcessStartIdentity(process.pid);
    if (identity.kind === "identity") {
      // The host runner's marker is inherited by isolated CLI processes as well.
      // Host /proc sees their host PIDs and same UID; a live owner is never reaped.
      // When the runner dies, the reaper can also clean an adopted bwrap and its children.
      process.env.SOUL_RUNNER_OWNER = `${process.pid}:${identity.value}`;
    } else {
      logger.warn("Runner owner identity unavailable; orphan cleanup disabled for this runner");
    }
  }
  const runtime = new RunnerChildRuntime(config, logger);
  process.once("SIGTERM", () => { stopLogRotation(); void runtime.shutdown(); });
  process.once("SIGINT", () => { stopLogRotation(); void runtime.shutdown(); });
  await runtime.start();
  await runtime.waitUntilClosed();
  stopLogRotation();
}

function readConfigArgument(args: string[]): string {
  const index = args.indexOf("--config");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error("runner entry requires --config <path>");
  return value;
}
