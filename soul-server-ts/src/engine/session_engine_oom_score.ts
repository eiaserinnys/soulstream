import type {
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { Logger } from "pino";

export const SESSION_ENGINE_OOM_SCORE_ADJ = 500;

type OomScoreLogger = Pick<Logger, "warn">;
type OomScoreFileWriter = (path: string, data: string) => Promise<void>;

export interface SessionEngineOomScoreOptions {
  platform?: NodeJS.Platform;
  writeFile?: OomScoreFileWriter;
  logger: OomScoreLogger;
}

export async function setSessionEngineOomScore(
  pid: number | undefined,
  options: SessionEngineOomScoreOptions,
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "linux" || pid === undefined) return false;
  const path = `/proc/${pid}/oom_score_adj`;
  const writer = options.writeFile ?? (async (target, data) => await writeFile(target, data, "utf8"));
  try {
    await writer(path, String(SESSION_ENGINE_OOM_SCORE_ADJ));
    return true;
  } catch (err) {
    options.logger.warn({ err, pid, path }, "Failed to raise session engine OOM score");
    return false;
  }
}

export function spawnClaudeSessionEngine(
  options: ClaudeSpawnOptions,
  logger: Logger,
): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: "pipe",
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => {
    logger.debug({ line: chunk.toString("utf8") }, "Claude Code stderr");
  });
  void setSessionEngineOomScore(child.pid, { logger });
  return child;
}
