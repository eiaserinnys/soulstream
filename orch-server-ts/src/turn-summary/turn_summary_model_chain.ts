import type { AntigravityEphemeralExecutor, AntigravityReasoningEffort } from "../llm/antigravity_ephemeral_executor.js";
import type { ClaudeEphemeralExecutor, ClaudeReasoningEffort } from "../llm/claude_ephemeral_executor.js";
import type { CodexExecGenerateOptions } from "./codex_exec_turn_summarizer.js";
import { findUsageLimitError, isTurnSummaryUsageLimitError } from "./error_chain.js";
import type { TurnSummaryConfig, TurnSummaryStage } from "./turn_summary_config.js";
import { TurnSummaryExecutionError } from "./turn_summary_execution_error.js";
import { TurnSummaryProviderUnavailableError } from "./turn_summary_provider_router.js";
import {
  buildTurnSummaryPrompt,
  type TurnSummarizer,
  type TurnSummaryInput,
  type TurnSummaryOptions,
  type TurnSummaryResult,
} from "./turn_summarizer.js";

export type ChainClaudeExecutor = Pick<ClaudeEphemeralExecutor, "generate">;
export type ChainAntigravityExecutor = Pick<AntigravityEphemeralExecutor, "generate">;

export interface ChainCodexStage {
  generate(
    prompt: string,
    config: TurnSummaryConfig,
    options?: CodexExecGenerateOptions,
  ): Promise<TurnSummaryResult>;
}

const ANTIGRAVITY_EFFORT: Record<TurnSummaryConfig["reasoningEffort"], AntigravityReasoningEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

const CLAUDE_EFFORT: Record<TurnSummaryConfig["reasoningEffort"], ClaudeReasoningEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** Which configured model order a chain runs: the turn summaries' or the session story's. */
export type ChainPurpose = "turn" | "session";

type ErrorMetrics = Pick<
  TurnSummaryExecutionError,
  "attempts" | "latencyMs" | "spawnDurationMs" | "peakConcurrentSpawns"
>;

/**
 * Runs the stages the summary settings list for its purpose, in order. A stage hands over to the
 * next only when it is out of quota or unusable (see STAGE_HANDOFF_ERROR_CODES); any other
 * failure, including a time-out, ends the chain. With no usable stage left the request ends as
 * a provider-unavailable skip, not a failure.
 */
export class ModelChainTurnSummarizer implements TurnSummarizer {
  constructor(private readonly deps: {
    readonly purpose: ChainPurpose;
    readonly codex: ChainCodexStage;
    readonly claude?: ChainClaudeExecutor;
    readonly antigravity?: ChainAntigravityExecutor;
    readonly info?: (message: string) => void;
    readonly antigravityEnabled?: () => boolean;
  }) {}

  async summarize(
    input: TurnSummaryInput,
    config: TurnSummaryConfig,
    options?: TurnSummaryOptions,
  ): Promise<TurnSummaryResult> {
    return await this.generate(buildTurnSummaryPrompt(input, config), config, options);
  }

  async generate(
    prompt: string,
    config: TurnSummaryConfig,
    options: CodexExecGenerateOptions = {},
  ): Promise<TurnSummaryResult> {
    const configured = this.deps.purpose === "turn" ? config.turnStages : config.sessionStages;
    const stages = configured.filter((stage) => this.isUsable(stage));
    if (stages.length === 0) throw new TurnSummaryProviderUnavailableError("codex");
    const failures: unknown[] = [];
    for (const [index, stage] of stages.entries()) {
      try {
        return await this.runStage(stage, prompt, config, options, failures.length === 0);
      } catch (error) {
        const next = stages[index + 1];
        if (next === undefined || !isTurnSummaryUsageLimitError(error)) {
          throw wrapFinalError(error, failures);
        }
        failures.push(error);
        this.deps.info?.(
          `Turn summary ${label(stage)} failed with ${String(findUsageLimitError(error)?.code)}; trying ${label(next)}`,
        );
      }
    }
    throw new Error("unreachable: the last stage always ends the chain");
  }

  private isUsable(stage: TurnSummaryStage): boolean {
    if (stage.backend === "codex") return true;
    if (stage.backend === "claude") return this.deps.claude !== undefined;
    return this.deps.antigravity !== undefined && this.deps.antigravityEnabled?.() !== false;
  }

  private async runStage(
    stage: TurnSummaryStage,
    prompt: string,
    config: TurnSummaryConfig,
    options: CodexExecGenerateOptions,
    first: boolean,
  ): Promise<TurnSummaryResult> {
    const timeoutMs = first ? config.timeoutMs : config.fallbackTimeoutMs;
    const maxAttempts = first ? options.maxAttempts ?? config.maxAttempts : 1;
    const request = {
      prompt,
      model: stage.model,
      timeoutMs,
      maxAttempts,
      concurrencyLimit: config.codexConcurrencyLimit,
      ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    };
    if (stage.backend === "claude") {
      return await this.deps.claude!.generate({
        ...request, reasoningEffort: CLAUDE_EFFORT[config.reasoningEffort],
      });
    }
    if (stage.backend === "antigravity") {
      return await this.deps.antigravity!.generate({
        ...request, reasoningEffort: ANTIGRAVITY_EFFORT[config.reasoningEffort],
      });
    }
    return await this.deps.codex.generate(
      prompt,
      { ...config, model: stage.model, timeoutMs },
      { ...options, maxAttempts },
    );
  }
}

function label(stage: TurnSummaryStage): string {
  return `${stage.backend}:${stage.model}`;
}

function metricsOf(error: unknown): ErrorMetrics {
  const zero = { attempts: 0, latencyMs: 0, spawnDurationMs: 0, peakConcurrentSpawns: 0 };
  if (error === null || typeof error !== "object") return zero;
  const record = error as Record<string, unknown>;
  const source = (typeof record.metrics === "object" && record.metrics !== null ? record.metrics : record) as Record<string, unknown>;
  const number = (key: keyof ErrorMetrics) => typeof source[key] === "number" ? source[key] as number : 0;
  return {
    attempts: number("attempts"),
    latencyMs: number("latencyMs"),
    spawnDurationMs: number("spawnDurationMs"),
    peakConcurrentSpawns: number("peakConcurrentSpawns"),
  };
}

function wrapFinalError(error: unknown, previous: readonly unknown[]): unknown {
  if (previous.length === 0 && error instanceof TurnSummaryExecutionError) return error;
  const metrics = metricsOf(error);
  return new TurnSummaryExecutionError(
    metrics.attempts, metrics.latencyMs, metrics.spawnDurationMs, metrics.peakConcurrentSpawns,
    error, previous,
  );
}
