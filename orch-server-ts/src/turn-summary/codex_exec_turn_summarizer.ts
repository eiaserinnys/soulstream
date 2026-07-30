import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeChildProcessEnv } from "../runtime/child_process_env.js";
import type { TurnSummaryConfig } from "./turn_summary_config.js";
import {
  buildTurnSummaryPrompt,
  type TurnSummarizer,
  type TurnSummaryInput,
  type TurnSummaryResult,
  type TurnSummaryUsage,
} from "./turn_summarizer.js";

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

export interface CodexExecTurnSummarizerOptions {
  readonly codexPath?: string;
  readonly processPort?: CodexExecProcessPort;
  readonly processEnv?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
}

export class TurnSummaryExecutionError extends Error {
  constructor(
    readonly attempts: number,
    readonly latencyMs: number,
    readonly spawnDurationMs: number,
    readonly peakConcurrentSpawns: number,
    cause: unknown,
  ) {
    super(`turn summary failed after ${attempts} attempts`, { cause });
    this.name = "TurnSummaryExecutionError";
  }
}

export function buildCodexExecInvocation(params: {
  readonly codexPath: string;
  readonly workspaceDir: string;
  readonly model: string;
  readonly reasoningEffort: TurnSummaryConfig["reasoningEffort"];
  readonly processEnv:
    | NodeJS.ProcessEnv
    | Readonly<Record<string, string | undefined>>;
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
      "-",
    ],
    env: sanitizeChildProcessEnv(params.processEnv),
    cwd: params.workspaceDir,
  };
}

export function parseCodexJsonl(
  stdout: string,
): { readonly content: string; readonly usage?: TurnSummaryUsage } {
  let content = "";
  let usage: TurnSummaryUsage | undefined;
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
  if (content.trim().length === 0) {
    throw new Error("codex exec produced no completed agent message");
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
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
        } else if (code !== 0) {
          reject(new Error(`codex exec exited ${code}: ${stderr.slice(-500)}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
      child.stdin.end(prompt, "utf8");
    });
  }
}

export class CodexExecTurnSummarizer implements TurnSummarizer {
  private readonly processPort: CodexExecProcessPort;
  private readonly nowMs: () => number;
  private readonly spawnLimiter = new CodexSpawnLimiter();

  constructor(private readonly options: CodexExecTurnSummarizerOptions) {
    this.processPort = options.processPort ?? new NodeCodexExecProcess();
    this.nowMs = options.nowMs ?? Date.now;
  }

  async summarize(
    input: TurnSummaryInput,
    config: TurnSummaryConfig,
  ): Promise<TurnSummaryResult> {
    const startedAt = this.nowMs();
    const prompt = buildTurnSummaryPrompt(input, config);
    if (!this.options.codexPath) {
      throw new Error("Codex CLI path is unavailable for turn summaries");
    }
    let lastError: unknown;
    let finishedAt = startedAt;
    let spawnDurationMs = 0;
    let peakConcurrentSpawns = 0;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const workspaceDir = await mkdtemp(
        join(tmpdir(), "soulstream-turn-summary-"),
      );
      try {
        const permit = await this.spawnLimiter.acquire(
          config.codexConcurrencyLimit,
        );
        peakConcurrentSpawns = Math.max(
          peakConcurrentSpawns,
          permit.concurrentSpawns,
        );
        const spawnStartedAt = this.nowMs();
        let parsed:
          | ReturnType<typeof parseCodexJsonl>
          | undefined;
        try {
          const result = await this.processPort.execute(
            buildCodexExecInvocation({
              codexPath: this.options.codexPath,
              workspaceDir,
              model: config.model,
              reasoningEffort: config.reasoningEffort,
              processEnv: this.options.processEnv ?? process.env,
            }),
            prompt,
            config.timeoutMs,
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
            model: config.model,
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
    throw new TurnSummaryExecutionError(
      config.maxAttempts,
      Math.max(0, finishedAt - startedAt),
      spawnDurationMs,
      peakConcurrentSpawns,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickUsage(value: Record<string, unknown>): TurnSummaryUsage | undefined {
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
    : usage as TurnSummaryUsage;
}
