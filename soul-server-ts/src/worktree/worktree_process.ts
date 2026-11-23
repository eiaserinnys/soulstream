import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  WORKTREE_PROCESS_CLOSE_CONFIRM_TIMEOUT_MS,
  WORKTREE_WINDOWS_TASKKILL_TIMEOUT_MS,
} from "./worktree_timeouts.js";

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
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  acceptedExitCodes?: number[];
}

export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
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
    let terminating = false;
    let truncated = false;
    let stdoutBytes = 0;
    let settled = false;
    let closed = false;
    let closeWaiter: (() => void) | undefined;
    const closePromise = new Promise<void>((done) => {
      closeWaiter = done;
    });

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    };
    const timeoutError = (terminationConfirmed: boolean, code?: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitProcessError(
        "PROCESS_TIMEOUT",
        `${input.command} timed out after ${input.timeoutMs}ms`,
        terminationConfirmed,
        code,
        Buffer.concat(stderr).toString("utf8"),
      ));
    };
    const terminate = (reason: "timeout" | "truncated" = "timeout") => {
      if (terminating || settled) return;
      terminating = true;
      void (async () => {
        const terminationConfirmed = child.pid === undefined
          ? false
          : process.platform === "win32"
            ? await terminateWindowsProcessTree(child.pid, child)
            : await terminatePosixProcessGroup(child.pid, child);
        const closeConfirmed = closed || await Promise.race([
          closePromise.then(() => true),
          delay(WORKTREE_PROCESS_CLOSE_CONFIRM_TIMEOUT_MS).then(() => false),
        ]);
        if (reason === "timeout" || !closeConfirmed || (!terminationConfirmed && !(process.platform === "win32" && closed))) { timeoutError(terminationConfirmed && closeConfirmed, child.exitCode); return; }
        if (settled) return;
        settled = true; cleanup();
        resolve({stdout:new StringDecoder("utf8").write(Buffer.concat(stdout)), stderr:Buffer.concat(stderr).toString("utf8"), exitCode:child.exitCode ?? 0, truncated:true});
      })();
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = input.maxStdoutBytes === undefined ? chunk.length : input.maxStdoutBytes - stdoutBytes;
      stdout.push(chunk.subarray(0, remaining));
      stdoutBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        truncated = true;
        terminate("truncated");
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (input.stdin !== undefined) child.stdin!.end(input.stdin);

    const timer = setTimeout(() => terminate(), input.timeoutMs);
    timer.unref();
    const abort = () => terminate();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) terminate();

    child.once("error", (error) => {
      if (settled || terminating) return;
      settled = true;
      cleanup();
      reject(new GitProcessError(
        "PROCESS_START_FAILED",
        `${input.command} failed to start: ${error.message}`,
        child.pid === undefined,
      ));
    });
    child.once("close", (code, signal) => {
      closed = true;
      closeWaiter?.();
      if (settled || terminating) return;
      settled = true;
      cleanup();
      const bytes = Buffer.concat(stdout);
      const out = truncated ? new StringDecoder("utf8").write(bytes) : bytes.toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (!truncated && !(input.acceptedExitCodes ?? [0]).includes(code ?? -1)) {
        reject(new GitProcessError(
          "PROCESS_FAILED",
          `${input.command} exited with ${code ?? signal ?? "unknown"}: ${err.trim()}`,
          true,
          code,
          err,
        ));
        return;
      }
      resolve({ stdout: out, stderr: err, exitCode: code ?? 0, ...(truncated ? { truncated: true } : {}) });
    });
  });
}

async function terminateWindowsProcessTree(
  pid: number,
  child: ReturnType<typeof spawn>,
): Promise<boolean> {
  return await new Promise((confirm) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      confirm(confirmed);
    };
    const timer = setTimeout(() => {
      killer.kill("SIGKILL");
      child.kill("SIGKILL");
      finish(false);
    }, WORKTREE_WINDOWS_TASKKILL_TIMEOUT_MS);
    timer.unref();
    killer.once("error", () => {
      child.kill("SIGKILL");
      finish(false);
    });
    killer.once("close", (code) => finish(code === 0));
  });
}

async function terminatePosixProcessGroup(
  pid: number,
  child: ReturnType<typeof spawn>,
): Promise<boolean> {
  signalProcessGroup(pid, "SIGTERM", child);
  await delay(100);
  if (!processGroupIsGone(pid)) signalProcessGroup(pid, "SIGKILL", child);
  const deadline = Date.now() + 1_000;
  while (!processGroupIsGone(pid) && Date.now() < deadline) await delay(20);
  return processGroupIsGone(pid);
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  child: ReturnType<typeof spawn>,
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The close path confirms whether the complete process group is gone.
    }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
