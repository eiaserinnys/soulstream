import { readFile } from "node:fs/promises";

import pino from "pino";

import { RunnerChildRuntime } from "./runner_child_runtime.js";
import { parseRunnerChildConfig } from "./runner_process_spawn.js";
import { startRunnerLogRotation } from "./runner_log_rotation.js";

const configPath = readConfigArgument(process.argv.slice(2));
const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
const config = parseRunnerChildConfig(parsed);
const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { component: "session-runner", sessionId: config.sessionId },
});
const stopLogRotation = startRunnerLogRotation(
  process.stdout.fd,
  config.paths.logPath,
  (error) => logger.error({ err: error }, "Runner log rotation failed"),
);
const runtime = new RunnerChildRuntime(config, logger);
process.once("SIGTERM", () => { stopLogRotation(); void runtime.shutdown(); });
process.once("SIGINT", () => { stopLogRotation(); void runtime.shutdown(); });
await runtime.start();
await runtime.waitUntilClosed();
stopLogRotation();

function readConfigArgument(args: string[]): string {
  const index = args.indexOf("--config");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error("runner entry requires --config <path>");
  return value;
}
