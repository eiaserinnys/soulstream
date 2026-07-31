import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

export type TurnSummaryLogger = {
  readonly debug?: (...args: unknown[]) => void;
  readonly info?: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
};

const TurnSummaryConfigFileSchema = z
  .object({
    enabled: z.boolean(),
    instruction: z.string().trim().min(1),
    story_instruction: z.string().trim().min(1),
    story_fold_threshold: z.number().int().positive(),
    story_fold_batch_size: z.number().int().positive(),
    story_completion_grace_ms: z.number().int().positive(),
    story_completion_min_summaries: z.number().int().positive(),
    story_completion_sweep_interval_ms: z.number().int().positive(),
    story_narrative_max_chars: z.number().int().positive(),
    provider: z.enum(["codex", "openai-api"]),
    model: z.string().trim().min(1),
    story_model: z.string().trim().min(1).optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    timeout_ms: z.number().int().positive(),
    max_attempts: z.number().int().min(1).max(2),
    codex_concurrency_limit: z.number().int().positive(),
    codepoint_limit: z.number().int().positive(),
    history_limit: z.number().int().min(0).max(5),
    excluded_folder_ids: z.array(z.string().uuid()),
  })
  .strict()
  .refine(
    (value) => value.story_fold_threshold >= value.story_fold_batch_size,
    {
      message:
        "story_fold_threshold must be greater than or equal to story_fold_batch_size",
      path: ["story_fold_threshold"],
    },
  );

const TurnSummaryConfigOverlaySchema = z
  .object({
    enabled: z.boolean().optional(),
    instruction: z.string().trim().min(1).optional(),
    story_instruction: z.string().trim().min(1).optional(),
    story_fold_threshold: z.number().int().positive().optional(),
    story_fold_batch_size: z.number().int().positive().optional(),
    story_completion_grace_ms: z.number().int().positive().optional(),
    story_completion_min_summaries: z.number().int().positive().optional(),
    story_completion_sweep_interval_ms: z.number().int().positive().optional(),
    story_narrative_max_chars: z.number().int().positive().optional(),
    provider: z.enum(["codex", "openai-api"]).optional(),
    model: z.string().trim().min(1).optional(),
    story_model: z.string().trim().min(1).optional(),
    reasoning_effort: z.enum([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]).optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_attempts: z.number().int().min(1).max(2).optional(),
    codex_concurrency_limit: z.number().int().positive().optional(),
    codepoint_limit: z.number().int().positive().optional(),
    history_limit: z.number().int().min(0).max(5).optional(),
    excluded_folder_ids: z.array(z.string().uuid()).optional(),
  })
  .strict();

const TurnSummaryConfigSchema = TurnSummaryConfigFileSchema
  .transform((value) => ({
    enabled: value.enabled,
    instruction: value.instruction,
    storyInstruction: value.story_instruction,
    storyFoldThreshold: value.story_fold_threshold,
    storyFoldBatchSize: value.story_fold_batch_size,
    storyCompletionGraceMs: value.story_completion_grace_ms,
    storyCompletionMinSummaries: value.story_completion_min_summaries,
    storyCompletionSweepIntervalMs: value.story_completion_sweep_interval_ms,
    storyNarrativeMaxChars: value.story_narrative_max_chars,
    provider: value.provider,
    model: value.model,
    storyModel: value.story_model ?? value.model,
    reasoningEffort: value.reasoning_effort,
    timeoutMs: value.timeout_ms,
    maxAttempts: value.max_attempts,
    codexConcurrencyLimit: value.codex_concurrency_limit,
    codepointLimit: value.codepoint_limit,
    historyLimit: value.history_limit,
    excludedFolderIds: value.excluded_folder_ids,
  }));

export type TurnSummaryConfig = z.output<typeof TurnSummaryConfigSchema>;

export class TurnSummaryConfigService {
  private lastSuccessful: TurnSummaryConfig | undefined;

  constructor(
    private readonly configPath: string,
    private readonly logger: TurnSummaryLogger,
  ) {}

  read(): TurnSummaryConfig {
    try {
      const source = readFileSync(this.configPath, "utf8");
      const base = TurnSummaryConfigFileSchema.parse(parse(source));
      const localConfigPath = resolveLocalConfigPath(this.configPath);
      const overlay = existsSync(localConfigPath)
        ? TurnSummaryConfigOverlaySchema.parse(
          parse(readFileSync(localConfigPath, "utf8")),
        )
        : {};
      const config = TurnSummaryConfigSchema.parse({ ...base, ...overlay });
      this.lastSuccessful = config;
      return config;
    } catch (error) {
      if (this.lastSuccessful === undefined) throw error;
      this.logger.warn(
        { error, configPath: this.configPath },
        "Invalid turn summary config update; keeping the last successful config",
      );
      return this.lastSuccessful;
    }
  }
}

function resolveLocalConfigPath(configPath: string): string {
  const extension = extname(configPath);
  return join(
    dirname(configPath),
    `${basename(configPath, extension)}.local${extension}`,
  );
}
