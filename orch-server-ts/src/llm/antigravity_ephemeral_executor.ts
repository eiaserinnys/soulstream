import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { sanitizeChildProcessEnv } from "../runtime/child_process_env.js";
import type {
  CodexExecGenerateRequest, CodexExecGenerateResult, CodexExecInvocation,
  CodexExecProcessTiming, CodexEphemeralExecutorOptions,
} from "./codex_ephemeral_executor.js";

export const ANTIGRAVITY_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type AntigravityReasoningEffort = typeof ANTIGRAVITY_REASONING_EFFORTS[number];
export type AntigravityEphemeralErrorCode =
  | "ANTIGRAVITY_UNAVAILABLE" | "ANTIGRAVITY_TIMEOUT" | "ANTIGRAVITY_RATE_LIMITED"
  | "ANTIGRAVITY_INVALID_OUTPUT" | "ANTIGRAVITY_EXEC_FAILED";
export type AntigravityExecGenerateRequest = Omit<CodexExecGenerateRequest,
  "reasoningEffort" | "disabledFeatures" | "disableWebSearch"> & {
    readonly reasoningEffort: AntigravityReasoningEffort;
  };
export interface AntigravityExecProcessPort {
  execute(invocation: CodexExecInvocation, input: string, timeoutMs: number, signal?: AbortSignal): Promise<{
    readonly stdout: string; readonly stderr: string; readonly exitCode: number | null;
  }>;
}
export type AntigravityEphemeralExecutorOptions = Omit<CodexEphemeralExecutorOptions, "codexPath" | "processPort"> & {
  readonly agyPath?: string;
  readonly processPort?: AntigravityExecProcessPort;
};
type ExecutionMetrics = Pick<CodexExecGenerateResult, "attempts" | "latencyMs" | "spawnDurationMs" | "peakConcurrentSpawns">;

export class AntigravityEphemeralExecutionError extends Error {
  constructor(readonly code: AntigravityEphemeralErrorCode, message: string,
    readonly metrics: ExecutionMetrics, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AntigravityEphemeralExecutionError";
  }
}
class AntigravityAttemptError extends Error {
  constructor(readonly code: AntigravityEphemeralErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AntigravityAttemptError";
  }
}
const rateLimitPattern = /\b429\b|RESOURCE_EXHAUSTED|quota|rate[ _-]?limit/i;

function parseOutput(stdout: string, stderr: string, exitCode: number | null,
  model: string, structured: boolean): Pick<CodexExecGenerateResult, "content" | "model" | "usage"> {
  let result: Record<string, unknown> | undefined;
  const errors: string[] = [];
  try {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || typeof event.event !== "string") throw new Error("Invalid event envelope");
      if (event.event === "init" && isRecord(event.init) && typeof event.init.model === "string") model = event.init.model;
      if (event.event === "result" && isRecord(event.result)) result = event.result;
      if (event.event === "step_update" && isRecord(event.step_update) && event.step_update.step_type === "error_message") {
        errors.push(JSON.stringify(event.step_update));
      }
    }
  } catch (error) {
    if (rateLimitPattern.test(stderr)) throw new AntigravityAttemptError("ANTIGRAVITY_RATE_LIMITED", stderr.slice(-1000));
    throw new AntigravityAttemptError("ANTIGRAVITY_INVALID_OUTPUT", "agy produced invalid NDJSON", error);
  }
  const failureText = [result?.status === "SUCCESS" ? result.error : JSON.stringify(result), ...errors, stderr].filter(Boolean).join("\n");
  if (rateLimitPattern.test(failureText)) {
    throw new AntigravityAttemptError("ANTIGRAVITY_RATE_LIMITED", failureText.slice(-1000));
  }
  if (exitCode !== 0 || result?.status !== "SUCCESS" || errors.length > 0) {
    throw new AntigravityAttemptError("ANTIGRAVITY_EXEC_FAILED", `agy exited ${exitCode}, status ${String(result?.status)}: ${failureText.slice(-1000)}`);
  }
  const content = structured
    ? (result.structured_output === undefined ? undefined : JSON.stringify(result.structured_output))
    : result.response;
  if (typeof content !== "string" || !content.trim()) {
    throw new AntigravityAttemptError("ANTIGRAVITY_INVALID_OUTPUT", structured
      ? "agy SUCCESS result has no structured_output" : "agy SUCCESS result has no response");
  }
  const usage: { input_tokens?: number; output_tokens?: number } = {};
  if (isRecord(result.usage)) {
    if (typeof result.usage.input_tokens === "number") usage.input_tokens = result.usage.input_tokens;
    if (typeof result.usage.output_tokens === "number") usage.output_tokens = result.usage.output_tokens;
  }
  return { content, model, ...(Object.keys(usage).length ? { usage } : {}) };
}

export class NodeAntigravityExecProcess implements AntigravityExecProcessPort {
  constructor(private readonly options: {
    readonly onProcessTiming?: (timing: CodexExecProcessTiming) => void;
  } = {}) {}

  execute(invocation: CodexExecInvocation, input: string, timeoutMs: number, signal?: AbortSignal):
    Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(cancelledError()); return; }
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd, env: invocation.env, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32", windowsHide: true,
      });
      const startedAt = performance.now();
      let spawnedAt: number | undefined;
      let firstStdoutAt: number | undefined;
      let timingReported = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      const kill = () => {
        if (process.platform !== "win32" && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* child may already have exited */ }
        }
        child.kill("SIGKILL");
      };
      const reportTiming = (exitCode: number | null) => {
        if (timingReported) return;
        timingReported = true;
        try {
          this.options.onProcessTiming?.({
            spawnToFirstStdoutMs: spawnedAt === undefined || firstStdoutAt === undefined
              ? null : Math.max(0, firstStdoutAt - spawnedAt),
            spawnToCloseMs: Math.max(0, performance.now() - (spawnedAt ?? startedAt)),
            timedOut, cancelled, exitCode,
          });
        } catch { /* observers must not affect child cleanup */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const onAbort = () => { cancelled = true; kill(); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { firstStdoutAt ??= performance.now(); stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("spawn", () => { spawnedAt = performance.now(); });
      child.once("error", error => {
        cleanup(); reportTiming(null);
        reject(new AntigravityAttemptError((error as NodeJS.ErrnoException).code === "ENOENT"
          ? "ANTIGRAVITY_UNAVAILABLE" : "ANTIGRAVITY_EXEC_FAILED", `agy failed to start: ${error.message}`, error));
      });
      child.once("close", exitCode => {
        cleanup(); reportTiming(exitCode);
        if (cancelled) reject(cancelledError());
        else if (timedOut) reject(new AntigravityAttemptError("ANTIGRAVITY_TIMEOUT", `agy timed out after ${timeoutMs}ms`));
        else resolve({ stdout, stderr, exitCode });
      });
      child.stdin.on("error", error => {
        // A child that rejects its input may close stdin before emitting its result/exit.
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") { stderr += error.message; kill(); }
      });
      child.stdin.end(input, "utf8");
    });
  }
}

export class AntigravityEphemeralExecutor {
  private readonly processPort: AntigravityExecProcessPort;
  private readonly nowMs: () => number;
  private readonly limiter = new AntigravitySpawnLimiter();

  constructor(private readonly options: AntigravityEphemeralExecutorOptions) {
    this.processPort = options.processPort ?? new NodeAntigravityExecProcess({ onProcessTiming: options.onProcessTiming });
    this.nowMs = options.nowMs ?? Date.now;
  }

  async generate(request: AntigravityExecGenerateRequest): Promise<CodexExecGenerateResult> {
    const startedAt = this.nowMs();
    let attempts = 0;
    let spawnDurationMs = 0;
    let peakConcurrentSpawns = 0;
    const metrics = (): ExecutionMetrics => ({ attempts, latencyMs: Math.max(0, this.nowMs() - startedAt), spawnDurationMs, peakConcurrentSpawns });
    if (!this.options.agyPath) throw new AntigravityEphemeralExecutionError("ANTIGRAVITY_UNAVAILABLE", "Antigravity CLI path is unavailable", metrics());
    let lastError: unknown;
    for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
      let workspaceDir: string | undefined;
      try {
        if (request.signal?.aborted) throw cancelledError();
        workspaceDir = await mkdtemp(join(tmpdir(), "soulstream-agy-ephemeral-"));
        const schemaPath = request.outputSchema === undefined ? undefined : join(workspaceDir, "output-schema.json");
        if (schemaPath) await writeFile(schemaPath, JSON.stringify(request.outputSchema), "utf8");
        const release = await this.limiter.acquire(request.signal);
        attempts = attempt;
        peakConcurrentSpawns = 1;
        const spawnStartedAt = this.nowMs();
        try {
          const result = await this.processPort.execute({
            command: this.options.agyPath,
            args: ["--output-format", "stream-json", "--input-format", "stream-json",
              "--sandbox", "--disable-slash-commands", ...(schemaPath ? ["--json-schema", schemaPath] : []),
              "--log-file", join(workspaceDir, "agy.log"), "--model", request.model, "--effort", request.reasoningEffort],
            cwd: workspaceDir, env: sanitizeChildProcessEnv(this.options.processEnv ?? process.env),
          }, `${JSON.stringify({ event: "user", message: { content: request.prompt } })}\n`, request.timeoutMs, request.signal);
          const parseStartedAt = this.nowMs();
          let parsed: ReturnType<typeof parseOutput>;
          try { parsed = parseOutput(result.stdout, result.stderr, result.exitCode, request.model, schemaPath !== undefined); }
          finally {
            try { this.options.onOutputParseTiming?.(Math.max(0, this.nowMs() - parseStartedAt)); }
            catch { /* observers must not affect execution */ }
          }
          return { ...parsed, ...metrics(), spawnDurationMs: spawnDurationMs + Math.max(0, this.nowMs() - spawnStartedAt) };
        } finally {
          spawnDurationMs += Math.max(0, this.nowMs() - spawnStartedAt);
          release();
        }
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted || error instanceof AntigravityAttemptError && error.code === "ANTIGRAVITY_RATE_LIMITED") break;
      } finally {
        if (workspaceDir) await rm(workspaceDir, { recursive: true, force: true });
      }
    }
    throw new AntigravityEphemeralExecutionError(
      lastError instanceof AntigravityAttemptError ? lastError.code : "ANTIGRAVITY_EXEC_FAILED",
      lastError instanceof Error ? lastError.message : "agy execution failed", metrics(), lastError,
    );
  }
}

// Each executor owns one permit; Codex requests have their own independent limiter.
class AntigravitySpawnLimiter {
  private active = false;
  private readonly waiters: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void;
    signal?: AbortSignal; onAbort: () => void }> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw cancelledError();
    if (!this.active) return this.grant();
    return await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort);
        reject(cancelledError());
      } };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }
  private grant(): () => void {
    this.active = true;
    return () => {
      this.active = false;
      const next = this.waiters.shift();
      if (next) { next.signal?.removeEventListener("abort", next.onAbort); next.resolve(this.grant()); }
    };
  }
}
function cancelledError(): AntigravityAttemptError {
  return new AntigravityAttemptError("ANTIGRAVITY_EXEC_FAILED", "agy execution was cancelled");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
