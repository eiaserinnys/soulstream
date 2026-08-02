import type { TurnSummaryConfig } from "./turn_summary_config.js";
import {
  buildTurnSummaryPrompt,
  type TurnSummarizer,
  type TurnSummaryInput,
  type TurnSummaryResult,
} from "./turn_summarizer.js";
import {
  CodexEphemeralExecutionError,
  CodexEphemeralExecutor,
  type CodexEphemeralExecutorOptions,
} from "../llm/codex_ephemeral_executor.js";

export {
  buildCodexExecInvocation,
  NodeCodexExecProcess,
  parseCodexJsonl,
  type CodexExecInvocation,
  type CodexExecProcessPort,
} from "../llm/codex_ephemeral_executor.js";

export interface CodexExecTurnSummarizerOptions
  extends CodexEphemeralExecutorOptions {}

export interface CodexExecGenerateOptions {
  readonly maxAttempts?: number;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
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

export class CodexExecTurnSummarizer implements TurnSummarizer {
  private readonly executor: CodexEphemeralExecutor;

  constructor(options: CodexExecTurnSummarizerOptions) {
    this.executor = new CodexEphemeralExecutor(options);
  }

  async summarize(
    input: TurnSummaryInput,
    config: TurnSummaryConfig,
  ): Promise<TurnSummaryResult> {
    return await this.generate(buildTurnSummaryPrompt(input, config), config);
  }

  async generate(
    prompt: string,
    config: TurnSummaryConfig,
    options: CodexExecGenerateOptions = {},
  ): Promise<TurnSummaryResult> {
    try {
      return await this.executor.generate({
        prompt,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeoutMs,
        maxAttempts: options.maxAttempts ?? config.maxAttempts,
        concurrencyLimit: config.codexConcurrencyLimit,
        ...(options.outputSchema === undefined
          ? {}
          : { outputSchema: options.outputSchema }),
      });
    } catch (error) {
      if (!(error instanceof CodexEphemeralExecutionError)) throw error;
      throw new TurnSummaryExecutionError(
        error.metrics.attempts,
        error.metrics.latencyMs,
        error.metrics.spawnDurationMs,
        error.metrics.peakConcurrentSpawns,
        error,
      );
    }
  }
}
