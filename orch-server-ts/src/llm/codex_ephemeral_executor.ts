import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeChildProcessEnv } from "../runtime/child_process_env.js";

export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export type CodexEphemeralErrorCode =
  | "CODEX_UNAVAILABLE"
  | "CODEX_TIMEOUT"
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
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface CodexExecGenerateRequest {
  readonly prompt: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly concurrencyLimit: number;
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
  execute(
    invocation: CodexExecInvocation,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
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
        clearTimeout(timer);
        if (timedOut) {
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
      child.stdin.end(prompt, "utf8");
    });
  }
}

export class CodexEphemeralExecutor {
  private readonly processPort: CodexExecProcessPort;
  private readonly nowMs: () => number;
  private readonly spawnLimiter = new CodexSpawnLimiter();

  constructor(private readonly options: CodexEphemeralExecutorOptions) {
    this.processPort = options.processPort ?? new NodeCodexExecProcess();
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
        const permit = await this.spawnLimiter.acquire(request.concurrencyLimit);
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
              ...(outputSchemaPath === undefined
                ? {}
                : { outputSchemaPath }),
            }),
            request.prompt,
            request.timeoutMs,
          );
          parsed = parseCodexJsonl(result.stdout);
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

class CodexSpawnLimiter {
  private activeSpawns = 0;
  private readonly waiters: Array<{
    readonly limit: number;
    readonly resolve: (permit: CodexSpawnPermit) => void;
  }> = [];

  async acquire(limit: number): Promise<CodexSpawnPermit> {
    if (this.waiters.length === 0 && this.activeSpawns < limit) {
      return this.grant();
    }
    return await new Promise<CodexSpawnPermit>((resolve) => {
      this.waiters.push({ limit, resolve });
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
      next.resolve(this.grant());
    }
  }
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
