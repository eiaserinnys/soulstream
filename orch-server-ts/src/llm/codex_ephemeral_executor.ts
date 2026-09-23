import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

import { sanitizeChildProcessEnv } from "../runtime/child_process_env.js";

export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export type CodexEphemeralErrorCode =
  | "CODEX_UNAVAILABLE"
  | "CODEX_TIMEOUT"
  | "CODEX_CANCELLED"
  | "CODEX_INVALID_OUTPUT"
  | "CODEX_EXEC_FAILED";

export interface CodexEphemeralUsage {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
}

export interface CodexExecInvocation {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}

export interface CodexExecProcessPort {
  execute(
    invocation: CodexExecInvocation,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface CodexExecProcessTiming {
  readonly spawnToFirstStdoutMs: number | null;
  readonly spawnToCloseMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly exitCode: number | null;
}

export interface CodexExecGenerateRequest {
  readonly prompt: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly concurrencyLimit: number;
  readonly signal?: AbortSignal;
  readonly disabledFeatures?: readonly string[];
  readonly disableWebSearch?: boolean;
}

export interface CodexExecGenerateResult {
  readonly content: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly attempts: number;
  readonly spawnDurationMs: number;
  readonly peakConcurrentSpawns: number;
  readonly usage?: CodexEphemeralUsage;
}

export interface CodexEphemeralExecutorOptions {
  readonly codexPath?: string;
  readonly processPort?: CodexExecProcessPort;
  readonly processEnv?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
  readonly onProcessTiming?: (timing: CodexExecProcessTiming) => void;
  readonly onOutputParseTiming?: (durationMs: number) => void;
}

type ExecutionMetrics = {
  readonly attempts: number;
  readonly latencyMs: number;
  readonly spawnDurationMs: number;
  readonly peakConcurrentSpawns: number;
};

export class CodexEphemeralExecutionError extends Error {
  constructor(
    readonly code: CodexEphemeralErrorCode,
    message: string,
    readonly metrics: ExecutionMetrics,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexEphemeralExecutionError";
  }
}

class CodexAttemptError extends Error {
  constructor(
    readonly code: CodexEphemeralErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexAttemptError";
  }
}

export function buildCodexExecInvocation(params: {
  readonly codexPath: string;
  readonly workspaceDir: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly processEnv:
    | NodeJS.ProcessEnv
    | Readonly<Record<string, string | undefined>>;
  readonly outputSchemaPath?: string;
  readonly disabledFeatures?: readonly string[];
  readonly disableWebSearch?: boolean;
}): CodexExecInvocation {
  return {
    command: params.codexPath,
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--ignore-rules",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      params.model,
      "--cd",
      params.workspaceDir,
      "--config",
      `model_reasoning_effort="${params.reasoningEffort}"`,
      ...(params.outputSchemaPath === undefined
        ? []
        : ["--output-schema", params.outputSchemaPath]),
      ...(params.disabledFeatures ?? []).flatMap((feature) => [
        "--disable",
        feature,
      ]),
      ...(params.disableWebSearch
        ? ["--config", 'web_search="disabled"']
        : []),
      "-",
    ],
    env: sanitizeChildProcessEnv(params.processEnv),
    cwd: params.workspaceDir,
  };
}

export function parseCodexJsonl(
  stdout: string,
): { readonly content: string; readonly usage?: CodexEphemeralUsage } {
  let content = "";
  let usage: CodexEphemeralUsage | undefined;
  try {
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (
        event.type === "item.completed" &&
        isRecord(event.item) &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        content = event.item.text;
      }
      if (event.type === "turn.completed" && isRecord(event.usage)) {
        usage = pickUsage(event.usage);
      }
    }
  } catch (error) {
    throw new CodexAttemptError(
      "CODEX_INVALID_OUTPUT",
      "codex exec produced invalid JSONL",
      error,
    );
  }
  if (content.trim().length === 0) {
    throw new CodexAttemptError(
      "CODEX_INVALID_OUTPUT",
      "codex exec produced no completed agent message",
    );
  }
  return usage === undefined
    ? { content: content.trim() }
    : { content: content.trim(), usage };
}

export class NodeCodexExecProcess implements CodexExecProcessPort {
  constructor(
    private readonly options: {
      readonly onProcessTiming?: (timing: CodexExecProcessTiming) => void;
    } = {},
  ) {}

  execute(
    invocation: CodexExecInvocation,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelledAttemptError());
        return;
      }
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const executeStartedAt = performance.now();
      let spawnedAt: number | undefined;
      let firstStdoutAt: number | undefined;
      let timingReported = false;
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      const killProcessTree = () => {
        const pid = child.pid;
        if (process.platform !== "win32" && pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              child.kill("SIGKILL");
              return;
            }
          }
        }
        child.kill("SIGKILL");
      };
      const reportTiming = (exitCode: number | null) => {
        if (timingReported) return;
        timingReported = true;
        try {
          this.options.onProcessTiming?.({
            spawnToFirstStdoutMs: spawnedAt === undefined || firstStdoutAt === undefined
              ? null
              : Math.max(0, firstStdoutAt - spawnedAt),
            spawnToCloseMs: Math.max(0, performance.now() - (spawnedAt ?? executeStartedAt)),
            timedOut,
            cancelled,
            exitCode,
          });
        } catch {
          // An optional observer must not affect child cleanup or search results.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cancelled = true;
        killProcessTree();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        firstStdoutAt ??= performance.now();
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        cleanup();
        reportTiming(null);
        const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(new CodexAttemptError(
          unavailable ? "CODEX_UNAVAILABLE" : "CODEX_EXEC_FAILED",
          unavailable
            ? `codex executable is unavailable: ${invocation.command}`
            : `codex exec failed to start: ${error.message}`,
          error,
        ));
      });
      child.once("close", (code) => {
        cleanup();
        reportTiming(code);
        if (cancelled) {
          reject(cancelledAttemptError());
        } else if (timedOut) {
          reject(new CodexAttemptError(
            "CODEX_TIMEOUT",
            `codex exec timed out after ${timeoutMs}ms`,
          ));
        } else if (code !== 0) {
          reject(new CodexAttemptError(
            "CODEX_EXEC_FAILED",
            `codex exec exited ${code}: ${stderr.slice(-500)}`,
          ));
        } else {
          resolve({ stdout, stderr });
        }
      });
      child.once("spawn", () => {
        spawnedAt = performance.now();
      });
      child.stdin.end(prompt, "utf8");
    });
  }
}

export class CodexEphemeralExecutor {
  private readonly processPort: CodexExecProcessPort;
  private readonly nowMs: () => number;
  private readonly spawnLimiter = new CodexSpawnLimiter();

  constructor(private readonly options: CodexEphemeralExecutorOptions) {
    this.processPort = options.processPort ?? new NodeCodexExecProcess({
      onProcessTiming: options.onProcessTiming,
    });
    this.nowMs = options.nowMs ?? Date.now;
  }

  async generate(request: CodexExecGenerateRequest): Promise<CodexExecGenerateResult> {
    const startedAt = this.nowMs();
    if (!this.options.codexPath) {
      throw new CodexEphemeralExecutionError(
        "CODEX_UNAVAILABLE",
        "Codex CLI path is unavailable",
        {
          attempts: 0,
          latencyMs: 0,
          spawnDurationMs: 0,
          peakConcurrentSpawns: 0,
        },
      );
    }
    let lastError: unknown;
    let finishedAt = startedAt;
    let spawnDurationMs = 0;
    let peakConcurrentSpawns = 0;
    for (let attempt = 1; attempt <= request.maxAttempts; attempt += 1) {
      if (request.signal?.aborted) {
        lastError = cancelledAttemptError();
        break;
      }
      const workspaceDir = await mkdtemp(
        join(tmpdir(), "soulstream-codex-ephemeral-"),
      );
      try {
        const outputSchemaPath = request.outputSchema === undefined
          ? undefined
          : join(workspaceDir, "output-schema.json");
        if (outputSchemaPath !== undefined) {
          await writeFile(
            outputSchemaPath,
            JSON.stringify(request.outputSchema),
            "utf8",
          );
        }
        const permit = await this.spawnLimiter.acquire(
          request.concurrencyLimit,
          request.signal,
        );
        peakConcurrentSpawns = Math.max(
          peakConcurrentSpawns,
          permit.concurrentSpawns,
        );
        const spawnStartedAt = this.nowMs();
        let parsed: ReturnType<typeof parseCodexJsonl> | undefined;
        try {
          const result = await this.processPort.execute(
            buildCodexExecInvocation({
              codexPath: this.options.codexPath,
              workspaceDir,
              model: request.model,
              reasoningEffort: request.reasoningEffort,
              processEnv: this.options.processEnv ?? process.env,
              ...(request.disabledFeatures === undefined
                ? {}
                : { disabledFeatures: request.disabledFeatures }),
              ...(request.disableWebSearch === undefined
                ? {}
                : { disableWebSearch: request.disableWebSearch }),
              ...(outputSchemaPath === undefined
                ? {}
                : { outputSchemaPath }),
            }),
            request.prompt,
            request.timeoutMs,
            request.signal,
          );
          const parseStartedAt = this.nowMs();
          try {
            parsed = parseCodexJsonl(result.stdout);
          } finally {
            try {
              this.options.onOutputParseTiming?.(
                Math.max(0, this.nowMs() - parseStartedAt),
              );
            } catch {
              // Measurement callbacks must not change query execution.
            }
          }
        } catch (error) {
          lastError = error;
        } finally {
          finishedAt = this.nowMs();
          spawnDurationMs += Math.max(0, finishedAt - spawnStartedAt);
          permit.release();
        }
        if (parsed !== undefined) {
          return {
            content: parsed.content,
            model: request.model,
            latencyMs: Math.max(0, finishedAt - startedAt),
            attempts: attempt,
            spawnDurationMs,
            peakConcurrentSpawns,
            ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
          };
        }
      } catch (error) {
        lastError = error;
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }
    const failure = classifyAttemptError(lastError);
    throw new CodexEphemeralExecutionError(
      failure.code,
      failure.message,
      {
        attempts: request.maxAttempts,
        latencyMs: Math.max(0, finishedAt - startedAt),
        spawnDurationMs,
        peakConcurrentSpawns,
      },
      lastError,
    );
  }
}

type CodexSpawnPermit = {
  readonly concurrentSpawns: number;
  readonly release: () => void;
};

type CodexSpawnWaiter = {
  readonly limit: number;
  readonly resolve: (permit: CodexSpawnPermit) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};

class CodexSpawnLimiter {
  private activeSpawns = 0;
  private readonly waiters: CodexSpawnWaiter[] = [];

  async acquire(limit: number, signal?: AbortSignal): Promise<CodexSpawnPermit> {
    if (signal?.aborted) throw cancelledAttemptError();
    if (this.waiters.length === 0 && this.activeSpawns < limit) {
      return this.grant();
    }
    return await new Promise<CodexSpawnPermit>((resolve, reject) => {
      const waiter: CodexSpawnWaiter = {
        limit,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        ...(signal === undefined
          ? {}
          : {
              onAbort: () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                signal.removeEventListener("abort", waiter.onAbort!);
                reject(cancelledAttemptError());
                this.flush();
              },
            }),
      };
      signal?.addEventListener("abort", waiter.onAbort!, { once: true });
      if (signal?.aborted) {
        waiter.onAbort?.();
        return;
      }
      this.waiters.push(waiter);
      this.flush();
    });
  }

  private grant(): CodexSpawnPermit {
    this.activeSpawns += 1;
    const concurrentSpawns = this.activeSpawns;
    let released = false;
    return {
      concurrentSpawns,
      release: () => {
        if (released) return;
        released = true;
        this.activeSpawns -= 1;
        this.flush();
      },
    };
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0];
      if (next === undefined || this.activeSpawns >= next.limit) return;
      this.waiters.shift();
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(cancelledAttemptError());
        continue;
      }
      next.resolve(this.grant());
    }
  }
}

function cancelledAttemptError(): CodexAttemptError {
  return new CodexAttemptError(
    "CODEX_CANCELLED",
    "codex exec was cancelled before completion",
  );
}

function classifyAttemptError(error: unknown): {
  readonly code: CodexEphemeralErrorCode;
  readonly message: string;
} {
  if (error instanceof CodexAttemptError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "CODEX_EXEC_FAILED",
    message: error instanceof Error ? error.message : "codex exec failed",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickUsage(value: Record<string, unknown>): CodexEphemeralUsage | undefined {
  const usage: Record<string, number> = {};
  for (const field of [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ]) {
    const tokenCount = value[field];
    if (typeof tokenCount === "number") usage[field] = tokenCount;
  }
  return Object.keys(usage).length === 0
    ? undefined
    : usage as CodexEphemeralUsage;
}
