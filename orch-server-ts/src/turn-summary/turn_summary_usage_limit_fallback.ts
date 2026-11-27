import {
  AntigravityEphemeralExecutionError,
  type AntigravityEphemeralExecutor,
  type AntigravityReasoningEffort,
} from "../llm/antigravity_ephemeral_executor.js";
import { isCodexUsageLimitError } from "../llm/codex_ephemeral_executor.js";
import type { CodexExecGenerateOptions } from "./codex_exec_turn_summarizer.js";
import type { TurnSummaryConfig } from "./turn_summary_config.js";
import { TurnSummaryExecutionError } from "./turn_summary_execution_error.js";
import {
  buildTurnSummaryPrompt,
  type TurnSummarizer,
  type TurnSummaryInput,
  type TurnSummaryOptions,
  type TurnSummaryResult,
} from "./turn_summarizer.js";

export type TurnSummaryFallbackExecutor = Pick<
  AntigravityEphemeralExecutor,
  "generate"
>;

export interface UsageLimitPrimary extends TurnSummarizer {
  generate(
    prompt: string,
    config: TurnSummaryConfig,
    options?: CodexExecGenerateOptions,
  ): Promise<TurnSummaryResult>;
}

const ANTIGRAVITY_EFFORT: Record<
  TurnSummaryConfig["reasoningEffort"],
  AntigravityReasoningEffort
> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

/**
 * Reruns a call on the configured fallback model only when the primary Codex call
 * failed with CODEX_USAGE_LIMIT. Every other failure passes through unchanged.
 */
export class UsageLimitFallbackTurnSummarizer implements UsageLimitPrimary {
  constructor(private readonly deps: {
    readonly primary: UsageLimitPrimary;
    readonly fallback?: TurnSummaryFallbackExecutor;
    readonly info?: (message: string) => void;
  }) {}

  async summarize(
    input: TurnSummaryInput,
    config: TurnSummaryConfig,
    options?: TurnSummaryOptions,
  ): Promise<TurnSummaryResult> {
    try {
      return await this.deps.primary.summarize(input, config, options);
    } catch (error) {
      return await this.recover(
        error,
        () => buildTurnSummaryPrompt(input, config),
        config,
        options,
      );
    }
  }

  async generate(
    prompt: string,
    config: TurnSummaryConfig,
    options: CodexExecGenerateOptions = {},
  ): Promise<TurnSummaryResult> {
    try {
      return await this.deps.primary.generate(prompt, config, options);
    } catch (error) {
      return await this.recover(error, () => prompt, config, options);
    }
  }

  private async recover(
    error: unknown,
    prompt: () => string,
    config: TurnSummaryConfig,
    options: CodexExecGenerateOptions | undefined,
  ): Promise<TurnSummaryResult> {
    const { fallback } = this.deps;
    if (
      fallback === undefined ||
      config.fallbackModel === undefined ||
      !isCodexUsageLimitError(error)
    ) {
      throw error;
    }
    this.deps.info?.(
      `Turn summary codex usage limit; using fallback model ${config.fallbackModel}`,
    );
    try {
      return await fallback.generate({
        prompt: prompt(),
        model: config.fallbackModel,
        reasoningEffort: ANTIGRAVITY_EFFORT[config.reasoningEffort],
        timeoutMs: config.fallbackTimeoutMs,
        maxAttempts: 1,
        concurrencyLimit: config.codexConcurrencyLimit,
        ...(options?.outputSchema === undefined
          ? {}
          : { outputSchema: options.outputSchema }),
      });
    } catch (fallbackError) {
      const metrics = fallbackError instanceof AntigravityEphemeralExecutionError
        ? fallbackError.metrics
        : { attempts: 0, latencyMs: 0, spawnDurationMs: 0, peakConcurrentSpawns: 0 };
      throw new TurnSummaryExecutionError(
        metrics.attempts,
        metrics.latencyMs,
        metrics.spawnDurationMs,
        metrics.peakConcurrentSpawns,
        error,
        fallbackError,
      );
    }
  }
}
