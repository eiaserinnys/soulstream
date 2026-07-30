import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sanitizeCodexEnv } from "../engine/codex_env.js";
import { withScratchWorkspaceEnv } from "../engine/scratch_workspace_env.js";

import type { TurnSummaryConfig } from "./turn_summary_config.js";
import {
  buildTurnSummaryPrompt,
  type TurnSummarizer,
  type TurnSummaryInput,
  type TurnSummaryResult,
  type TurnSummaryUsage,
} from "./turn_summarizer.js";

export interface CodexExecInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface CodexExecProcessPort {
  execute(
    invocation: CodexExecInvocation,
    prompt: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface CodexExecTurnSummarizerOptions {
  codexPath?: string;
  processPort?: CodexExecProcessPort;
  processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  nowMs?: () => number;
}

export class TurnSummaryExecutionError extends Error {
  constructor(
    readonly attempts: number,
    readonly latencyMs: number,
    cause: unknown,
  ) {
    super(`turn summary failed after ${attempts} attempts`, { cause });
    this.name = "TurnSummaryExecutionError";
  }
}

export function buildCodexExecInvocation(params: {
  codexPath: string;
  workspaceDir: string;
  model: string;
  reasoningEffort: TurnSummaryConfig["reasoningEffort"];
  processEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): CodexExecInvocation {
  const env = withScratchWorkspaceEnv(sanitizeCodexEnv(params.processEnv), {
    workspaceDir: params.workspaceDir,
    agentId: "turn-summary",
  });
  // Common billing-switch keys were removed by sanitizeCodexEnv.
  // Turn summaries additionally force ChatGPT OAuth over explicit Codex API auth.
  delete env.CODEX_API_KEY;

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
    env,
    cwd: params.workspaceDir,
  };
}

export function parseCodexJsonl(
  stdout: string,
): { content: string; usage?: TurnSummaryUsage } {
  let content = "";
  let usage: TurnSummaryUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "item.completed" && isRecord(event.item)) {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        content = event.item.text;
      }
    }
    if (event.type === "turn.completed" && isRecord(event.usage)) {
      usage = pickUsage(event.usage);
    }
  }
  if (!content.trim()) {
    throw new Error("codex exec produced no completed agent message");
  }
  return usage && Object.keys(usage).length > 0
    ? { content: content.trim(), usage }
    : { content: content.trim() };
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
        ...(needsWindowsCommandShell(invocation.command, process.platform)
          ? { shell: true }
          : {}),
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
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`codex exec timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`codex exec exited ${code}: ${stderr.slice(-500)}`));
          return;
        }
        resolve({ stdout, stderr });
      });
      child.stdin.end(prompt, "utf8");
    });
  }
}

export class CodexExecTurnSummarizer implements TurnSummarizer {
  private readonly processPort: CodexExecProcessPort;
  private readonly nowMs: () => number;

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
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const workspaceDir = await mkdtemp(join(tmpdir(), "soulstream-turn-summary-"));
      try {
        const invocation = buildCodexExecInvocation({
          codexPath: this.options.codexPath,
          workspaceDir,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          processEnv: this.options.processEnv ?? process.env,
        });
        const result = await this.processPort.execute(
          invocation,
          prompt,
          config.timeoutMs,
        );
        const parsed = parseCodexJsonl(result.stdout);
        return {
          content: parsed.content,
          model: config.model,
          latencyMs: Math.max(0, this.nowMs() - startedAt),
          attempts: attempt,
          ...(parsed.usage ? { usage: parsed.usage } : {}),
        };
      } catch (err) {
        lastError = err;
      } finally {
        await rm(workspaceDir, { recursive: true, force: true });
      }
    }
    throw new TurnSummaryExecutionError(
      config.maxAttempts,
      Math.max(0, this.nowMs() - startedAt),
      lastError,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickUsage(value: Record<string, unknown>): TurnSummaryUsage | undefined {
  const usage: TurnSummaryUsage = {};
  for (const field of [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
  ] as const) {
    if (typeof value[field] === "number") usage[field] = value[field];
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function needsWindowsCommandShell(
  command: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") return false;
  const lower = command.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}
