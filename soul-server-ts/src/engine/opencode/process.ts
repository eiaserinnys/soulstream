import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "pino";
import {
  cleanUpAntigravityDescendants,
  snapshotAntigravityDescendants,
} from "../antigravity/process.js";

export interface OpenCodeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

const RATE_LIMIT_FAILURE = "OpenCode free tier rate limit exceeded (Rate limit exceeded). Try again later or use another model.";

function isOpenCode119RateLimitLogLine(line: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object") return false;
  const log = value as Record<string, unknown>;
  const error = log.error;
  if (!error || typeof error !== "object") return false;
  const errorText = (error as Record<string, unknown>).error;
  return log.level === "ERROR"
    && log.message === "stream error"
    && log.small === false
    && typeof errorText === "string"
    && (errorText.startsWith("AI_APICallError") || errorText.startsWith("AI_RetryError"))
    && errorText.includes("Rate limit exceeded");
}

/** Uses the runner's Antigravity process-group interrupt and descendant cleanup contract. */
export function launchOpenCodeProcess(options: {
  executablePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  logger: Pick<Logger, "warn">;
}) {
  const child = spawn(options.executablePath, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let failure: string | undefined;
  let interrupted = false;
  let initialized = false;
  let closed = false;
  let rateLimitDetected = false;
  let descendants: ReturnType<typeof snapshotAntigravityDescendants> = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.on("error", (error: Error) => { failure ??= error.message; });
  child.on("error", () => { failure ??= "OpenCode CLI failed to start"; });

  const done = new Promise<OpenCodeExit>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      try {
        const terminatedProcessCount = cleanUpAntigravityDescendants(descendants);
        if (terminatedProcessCount > 0) options.logger.warn(
          { terminatedProcessCount }, "OpenCode interrupted tool descendants received SIGTERM",
        );
      } catch {
        failure ??= "OpenCode tool descendant cleanup failed";
      }
      resolve({ code, signal, ...(failure ? { error: failure } : {}) });
    });
  });

  function signalGroup(): boolean {
    if (closed || !child.pid) return false;
    descendants = snapshotAntigravityDescendants(child.pid);
    try {
      process.kill(-child.pid, "SIGINT");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }

  function markInitialized(): void {
    initialized = true;
    if (interrupted) signalGroup();
  }

  function interrupt(): boolean {
    if (closed || !child.pid) return false;
    if (interrupted) return true;
    interrupted = true;
    return initialized ? signalGroup() : true;
  }

  const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
  stderrLines.on("line", (line) => {
    if (rateLimitDetected || !isOpenCode119RateLimitLogLine(line)) return;
    rateLimitDetected = true;
    failure = RATE_LIMIT_FAILURE;
    markInitialized();
    interrupt();
  });

  async function* events(): AsyncIterable<string> {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (line.trim()) yield line;
    }
  }

  child.stdin.end(options.input, "utf8");
  return {
    events: events(),
    done,
    get interrupted() { return interrupted; },
    markInitialized,
    interrupt,
  };
}
