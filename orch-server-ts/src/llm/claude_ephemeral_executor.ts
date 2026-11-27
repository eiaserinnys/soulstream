import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

import { isRecord } from "@soulstream/wire-schema/json-record";

import { sanitizeChildProcessEnv } from "../runtime/child_process_env.js";
import type { CodexExecGenerateResult } from "./codex_ephemeral_executor.js";

export const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeReasoningEffort = typeof CLAUDE_REASONING_EFFORTS[number];

export type ClaudeEphemeralErrorCode =
  | "CLAUDE_UNAVAILABLE" | "CLAUDE_TIMEOUT" | "CLAUDE_USAGE_LIMIT"
  | "CLAUDE_INVALID_OUTPUT" | "CLAUDE_EXEC_FAILED";

export interface ClaudeExecGenerateRequest {
  readonly prompt: string;
  readonly model: string;
  readonly reasoningEffort: ClaudeReasoningEffort;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly concurrencyLimit: number;
  readonly signal?: AbortSignal;
}

export interface ClaudeEphemeralExecutorOptions {
  /** Defaults to `claude` on PATH. */
  readonly claudePath?: string;
  /** Access token of a central pool account, or null when none can be used right now. */
  readonly oneShotToken: () => Promise<string | null>;
  readonly processEnv?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
}

type ExecutionMetrics = Pick<
  CodexExecGenerateResult,
  "attempts" | "latencyMs" | "spawnDurationMs" | "peakConcurrentSpawns"
>;

export class ClaudeEphemeralExecutionError extends Error {
  constructor(
    readonly code: ClaudeEphemeralErrorCode,
    message: string,
    readonly metrics: ExecutionMetrics,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ClaudeEphemeralExecutionError";
  }
}

class ClaudeAttemptError extends Error {
  constructor(readonly code: ClaudeEphemeralErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ClaudeAttemptError";
  }
}

const SYSTEM_PROMPT = "You are a text-processing assistant. Follow the instructions in the user message exactly.";

// Copied from soul-server-ts engine/claude_transient_rate_limit_retry.ts; orch does not import soul-server-ts.
const QUOTA_EXHAUSTION_PATTERN =
  /hit your usage limit|out of (extra )?usage|five_hour|seven_day|out_of_credits|spend_limit|billing_error|insufficient_quota/i;
const RATE_LIMIT_429_PATTERN =
  /\b429\b|prefill_cap_refused|cell is at capacity|rate_limit_error|Request rejected \(429\)/i;
const AUTH_FAILURE_PATTERN =
  /authentication_failed|authentication_error|invalid (x-api-key|api key|bearer token|oauth token)|OAuth token (has expired|revoked)|not logged in|please run \/login|\b401\b/i;

interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export class ClaudeEphemeralExecutor {
  private readonly nowMs: () => number;
  private readonly limiter = new ClaudeSpawnLimiter();

  constructor(private readonly options: ClaudeEphemeralExecutorOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async generate(request: ClaudeExecGenerateRequest): Promise<CodexExecGenerateResult> {
    const startedAt = this.nowMs();
    let attempts = 0;
    let spawnDurationMs = 0;
    let peakConcurrentSpawns = 0;
    const metrics = (): ExecutionMetrics => ({
      attempts, latencyMs: Math.max(0, this.nowMs() - startedAt), spawnDurationMs, peakConcurrentSpawns,
    });
    let lastError: unknown;
    for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
      try {
        if (request.signal?.aborted) throw new ClaudeAttemptError("CLAUDE_EXEC_FAILED", "claude execution was cancelled");
        const token = await this.options.oneShotToken();
        if (token === null) throw new ClaudeAttemptError("CLAUDE_UNAVAILABLE", "No central Claude account is usable");
        const release = await this.limiter.acquire(request.concurrencyLimit, request.signal);
        attempts = attempt;
        const spawnStartedAt = this.nowMs();
        try {
          peakConcurrentSpawns = Math.max(peakConcurrentSpawns, this.limiter.active);
          const parsed = await this.runOnce(request, token);
          return { ...parsed, ...metrics(), spawnDurationMs: spawnDurationMs + Math.max(0, this.nowMs() - spawnStartedAt) };
        } finally {
          spawnDurationMs += Math.max(0, this.nowMs() - spawnStartedAt);
          release();
        }
      } catch (error) {
        lastError = error;
        if (request.signal?.aborted) break;
        if (error instanceof ClaudeAttemptError &&
          (error.code === "CLAUDE_USAGE_LIMIT" || error.code === "CLAUDE_UNAVAILABLE")) break;
      }
    }
    throw new ClaudeEphemeralExecutionError(
      lastError instanceof ClaudeAttemptError ? lastError.code : "CLAUDE_EXEC_FAILED",
      lastError instanceof Error ? lastError.message : "claude execution failed",
      metrics(),
      lastError,
    );
  }

  private async runOnce(
    request: ClaudeExecGenerateRequest,
    token: string,
  ): Promise<Pick<CodexExecGenerateResult, "content" | "model" | "usage">> {
    // HOME and CLAUDE_CONFIG_DIR point at a throwaway directory so the host's own Claude
    // credentials are never read or refreshed; auth comes only from CLAUDE_CODE_OAUTH_TOKEN.
    const home = await mkdtemp(join(tmpdir(), "soulstream-claude-ephemeral-"));
    try {
      const configDir = join(home, ".claude");
      await mkdir(configDir, { recursive: true });
      const env = sanitizeChildProcessEnv(this.options.processEnv ?? process.env);
      delete env.ANTHROPIC_AUTH_TOKEN;
      const output = await runProcess({
        command: this.options.claudePath ?? "claude",
        args: [
          "-p",
          "--model", request.model,
          "--effort", request.reasoningEffort,
          "--output-format", "json",
          "--no-session-persistence",
          "--tools", "",
          "--disable-slash-commands",
          "--setting-sources", "",
          "--strict-mcp-config",
          "--system-prompt", SYSTEM_PROMPT,
          ...(request.outputSchema === undefined ? [] : ["--json-schema", JSON.stringify(request.outputSchema)]),
        ],
        cwd: home,
        env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token, HOME: home, CLAUDE_CONFIG_DIR: configDir },
        input: request.prompt,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      return parseOutput(output, request.model, request.outputSchema !== undefined);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

function parseOutput(
  output: ProcessOutput,
  presetModel: string,
  structured: boolean,
): Pick<CodexExecGenerateResult, "content" | "model" | "usage"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch (error) {
    throw classifyFailure(output.stdout, output.stderr, output.exitCode, "claude produced invalid JSON", error);
  }
  const result = Array.isArray(parsed)
    ? [...parsed].reverse().find((entry) => isRecord(entry) && entry.type === "result")
    : parsed;
  if (!isRecord(result)) {
    throw new ClaudeAttemptError("CLAUDE_INVALID_OUTPUT", "claude output has no result object");
  }
  const resultText = typeof result.result === "string" ? result.result : "";
  if (result.is_error === true || output.exitCode !== 0) {
    throw classifyFailure(resultText, output.stderr, output.exitCode, `claude exited ${output.exitCode}`);
  }
  const content = structured
    ? (result.structured_output === undefined ? undefined : JSON.stringify(result.structured_output))
    : resultText;
  if (typeof content !== "string" || !content.trim()) {
    throw new ClaudeAttemptError("CLAUDE_INVALID_OUTPUT", structured
      ? "claude result has no structured_output" : "claude result has no text");
  }
  const modelIds = isRecord(result.modelUsage) ? Object.keys(result.modelUsage) : [];
  const usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } = {};
  if (isRecord(result.usage)) {
    if (typeof result.usage.input_tokens === "number") usage.input_tokens = result.usage.input_tokens;
    if (typeof result.usage.cache_read_input_tokens === "number") usage.cached_input_tokens = result.usage.cache_read_input_tokens;
    if (typeof result.usage.output_tokens === "number") usage.output_tokens = result.usage.output_tokens;
  }
  return {
    content,
    model: modelIds[0] ?? presetModel,
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
  };
}

function classifyFailure(
  stdoutText: string,
  stderr: string,
  exitCode: number | null,
  fallbackMessage: string,
  cause?: unknown,
): ClaudeAttemptError {
  const text = [stdoutText, stderr].filter(Boolean).join("\n");
  const detail = `${fallbackMessage}: ${text.slice(-1000)}`;
  if (QUOTA_EXHAUSTION_PATTERN.test(text) || RATE_LIMIT_429_PATTERN.test(text)) {
    return new ClaudeAttemptError("CLAUDE_USAGE_LIMIT", detail, cause);
  }
  if (AUTH_FAILURE_PATTERN.test(text)) return new ClaudeAttemptError("CLAUDE_UNAVAILABLE", detail, cause);
  return new ClaudeAttemptError(cause === undefined ? "CLAUDE_EXEC_FAILED" : "CLAUDE_INVALID_OUTPUT",
    exitCode === 0 ? detail : `${detail} (exit ${exitCode})`, cause);
}

function runProcess(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly input: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.command, [...params.args], {
      cwd: params.cwd, env: params.env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true,
    });
    const startedAt = performance.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const kill = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* already exited */ }
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, params.timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    const cleanup = () => { clearTimeout(timer); params.signal?.removeEventListener("abort", onAbort); };
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      cleanup();
      reject(new ClaudeAttemptError(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "CLAUDE_UNAVAILABLE" : "CLAUDE_EXEC_FAILED",
        `claude failed to start: ${error.message}`, error,
      ));
    });
    child.once("close", (exitCode) => {
      cleanup();
      if (cancelled) reject(new ClaudeAttemptError("CLAUDE_EXEC_FAILED", "claude execution was cancelled"));
      else if (timedOut) reject(new ClaudeAttemptError("CLAUDE_TIMEOUT",
        `claude timed out after ${Math.round(performance.now() - startedAt)}ms`));
      else resolve({ stdout, stderr, exitCode });
    });
    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") { stderr += error.message; kill(); }
    });
    child.stdin.end(params.input, "utf8");
  });
}

interface SpawnWaiter {
  readonly limit: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/** Caps concurrent claude children at the request's concurrencyLimit. */
class ClaudeSpawnLimiter {
  active = 0;
  private readonly waiters: SpawnWaiter[] = [];

  async acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new ClaudeAttemptError("CLAUDE_EXEC_FAILED", "claude execution was cancelled");
    if (this.waiters.length === 0 && this.active < limit) return this.grant();
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: SpawnWaiter = {
        limit, resolve, reject, signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ClaudeAttemptError("CLAUDE_EXEC_FAILED", "claude execution was cancelled"));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private grant(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters[0];
      if (next !== undefined && this.active < next.limit) {
        this.waiters.shift();
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve(this.grant());
      }
    };
  }
}
