import { spawn } from "node:child_process";

export type WorktreeProcessErrorCode =
  | "PROCESS_START_FAILED"
  | "PROCESS_FAILED"
  | "PROCESS_TIMEOUT";

export class GitProcessError extends Error {
  constructor(
    public readonly code: WorktreeProcessErrorCode,
    message: string,
    public readonly terminationConfirmed: boolean,
    public readonly exitCode?: number | null,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "GitProcessError";
  }
}

export interface BoundedProcessInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute without a shell and never report timeout until the child process
 * tree is gone. Repository locks may therefore be released only after this
 * promise settles with terminationConfirmed=true.
 */
export async function runBoundedProcess(
  input: BoundedProcessInput,
): Promise<BoundedProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let windowsTreeKill: Promise<boolean> | undefined;
    let settled = false;

    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (input.stdin !== undefined) child.stdin!.end(input.stdin);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        windowsTreeKill = new Promise((confirm) => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => {
            child.kill("SIGKILL");
            confirm(false);
          });
          killer.once("close", (code) => confirm(code === 0));
        });
      } else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 100);
        killTimer.unref();
      }
    }, input.timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new GitProcessError(
        "PROCESS_START_FAILED",
        `${input.command} failed to start: ${error.message}`,
        child.pid === undefined,
      ));
    });
    child.once("close", (code, signal) => {
      void (async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");
        if (timedOut) {
          const terminationConfirmed = process.platform === "win32"
            ? await (windowsTreeKill ?? Promise.resolve(false))
            : processGroupIsGone(child.pid);
          reject(new GitProcessError(
            "PROCESS_TIMEOUT",
            `${input.command} timed out after ${input.timeoutMs}ms`,
            terminationConfirmed,
            code,
            err,
          ));
          return;
        }
        if (code !== 0) {
          reject(new GitProcessError(
            "PROCESS_FAILED",
            `${input.command} exited with ${code ?? signal ?? "unknown"}: ${err.trim()}`,
            true,
            code,
            err,
          ));
          return;
        }
        resolve({ stdout: out, stderr: err, exitCode: code });
      })();
    });
  });
}

function processGroupIsGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
