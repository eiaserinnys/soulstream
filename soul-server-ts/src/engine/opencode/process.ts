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
  let descendants: ReturnType<typeof snapshotAntigravityDescendants> = [];
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stderr.resume();
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
    markInitialized(): void {
      initialized = true;
      if (interrupted) signalGroup();
    },
    interrupt(): boolean {
      if (closed || !child.pid) return false;
      if (interrupted) return true;
      interrupted = true;
      return initialized ? signalGroup() : true;
    },
  };
}
