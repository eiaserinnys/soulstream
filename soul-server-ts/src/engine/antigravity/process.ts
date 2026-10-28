import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Logger } from "pino";
import { antigravityEnvironment } from "../antigravity_env.js";
import { parseAntigravityEvent, type AntigravityEvent, type AntigravityExit } from "./events.js";

type DescendantIdentity = { pid: number; startTime: string };

/** Follow the CLI's current descendants, including children owned by other threads. */
export function snapshotAntigravityDescendants(pid: number): DescendantIdentity[] {
  if (!existsSync("/proc")) return [];
  const descendants: DescendantIdentity[] = [];
  const seen = new Set([pid]);
  const pending = [pid];
  while (pending.length) {
    const parent = pending.pop()!;
    try {
      for (const thread of readdirSync(`/proc/${parent}/task`)) {
        const children = readFileSync(`/proc/${parent}/task/${thread}/children`, "utf8").trim();
        for (const value of children ? children.split(/\s+/) : []) {
          const childPid = Number(value);
          if (seen.has(childPid)) continue;
          seen.add(childPid);
          try {
            const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            descendants.push({ pid: childPid, startTime: fields[19]! });
            pending.push(childPid);
          } catch (error) {
            if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          }
        }
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return descendants;
}

/** One SIGTERM per surviving identity, after CLI close. No escalation or waiting. */
export function cleanUpAntigravityDescendants(descendants: readonly DescendantIdentity[]): number {
  if (!existsSync("/proc")) return 0;
  let count = 0;
  for (const child of descendants) {
    try {
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[19] !== child.startTime) continue;
      process.kill(child.pid, "SIGTERM");
      count += 1;
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return count;
}

/** Keep process ownership until close; SIGINT alone does not stop detached tool groups. */
export function launchAntigravityProcess(options: {
  executablePath: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; input: string;
  logger: Pick<Logger, "warn">;
  exitGraceMs?: number;
}) {
  const child = spawn(options.executablePath, options.args, {
    cwd: options.cwd, env: antigravityEnvironment(options.env),
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let failure: string | undefined;
  let interrupted = false;
  let initialized = false;
  let closed = false;
  let sawResult = false;
  let forcedAfterResult = false;
  let exitGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let descendants: DescendantIdentity[] = [];
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  // Do not retain or log stderr: diagnostics may include credentials and input.
  child.stderr.resume();
  child.stdin.on("error", (error: Error) => { failure ??= error.message; });
  child.on("error", (error: Error) => { failure ??= error.message; });
  function clearExitGraceTimer(): void {
    if (exitGraceTimer !== undefined) {
      clearTimeout(exitGraceTimer);
      exitGraceTimer = undefined;
    }
  }
  function armExitGraceTimer(): void {
    if (closed) return;
    clearExitGraceTimer();
    exitGraceTimer = setTimeout(() => {
      exitGraceTimer = undefined;
      if (closed || !child.pid) return;
      descendants = snapshotAntigravityDescendants(child.pid);
      try {
        process.kill(-child.pid, "SIGKILL");
        if (sawResult) forcedAfterResult = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure ??= "Antigravity process group SIGKILL failed";
        }
      }
    }, options.exitGraceMs ?? 15_000);
  }
  const done = new Promise<AntigravityExit>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      clearExitGraceTimer();
      try {
        const terminatedProcessCount = cleanUpAntigravityDescendants(descendants);
        if (terminatedProcessCount > 0) options.logger.warn(
          { terminatedProcessCount }, "Antigravity interrupted tool descendants received SIGTERM",
        );
      } catch {
        failure ??= "Antigravity tool descendant cleanup failed";
      }
      resolve({ code, signal, ...(failure ? { error: failure } : {}),
        ...(forcedAfterResult ? { forcedAfterResult: true } : {}) });
    });
  });
  function signalGroup(armGraceAfterInterrupt = false): boolean {
    if (closed || !child.pid) return false;
    descendants = snapshotAntigravityDescendants(child.pid);
    try {
      process.kill(-child.pid, "SIGINT");
      if (armGraceAfterInterrupt) armExitGraceTimer();
      return true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  async function* events(): AsyncIterable<AntigravityEvent> {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (!line.trim() || failure) continue;
      let event: AntigravityEvent;
      try { event = parseAntigravityEvent(line); }
      catch {
        failure = "Invalid Antigravity JSONL output";
        signalGroup();
        continue;
      }
      if (event.event === "init") {
        initialized = true;
        if (interrupted) signalGroup(true);
      }
      if (event.event === "result") {
        sawResult = true;
        armExitGraceTimer();
      }
      yield event;
    }
  }
  child.stdin.end(options.input);
  return {
    events: events(), done,
    get interrupted() { return interrupted; },
    interrupt(): boolean {
      if (closed || !child.pid) return false;
      if (interrupted) return true;
      // Record the pending request immediately; init supplies the resumable ID
      // before the first actual SIGINT for both new and resumed conversations.
      interrupted = true;
      return initialized ? signalGroup(true) : true;
    },
  };
}
