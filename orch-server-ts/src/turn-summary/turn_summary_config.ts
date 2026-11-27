import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";
import { resolveModelPreset, type ModelPreset } from "@soulstream/model-catalog";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";
import {
  isSelectableSummaryPreset,
  type SummarySettingsReader,
  type SummarySettingsValue,
} from "../settings/summary_settings.js";

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
    story_fold_max_batches_per_run: z.number().int().positive(),
    story_completed_fold_max_summaries: z.number().int().positive(),
    story_completion_grace_ms: z.number().int().positive(),
    story_completion_min_summaries: z.number().int().positive(),
    story_completion_sweep_interval_ms: z.number().int().positive(),
    story_narrative_max_chars: z.number().int().positive(),
    story_timeout_ms: z.number().int().positive(),
    fallback_timeout_ms: z.number().int().positive(),
    story_fold_failure_cooldown_ms: z.number().int().positive(),
    catch_up_interval_ms: z.number().int().positive(),
    catch_up_window_hours: z.number().int().positive(),
    catch_up_max_jobs_per_round: z.number().int().positive(),
    provider: z.enum(["codex", "openai-api"]),
    model: z.string().trim().min(1).optional(),
    story_model: z.string().trim().min(1).optional(),
    preferred_model_presets: z.array(z.string().trim().min(1)).optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    instruction_extraction_model: z.string().trim().min(1).optional(),
    instruction_extraction_reasoning_effort: z.enum([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]),
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
    story_fold_max_batches_per_run: z.number().int().positive().optional(),
    story_completed_fold_max_summaries: z.number().int().positive().optional(),
    story_completion_grace_ms: z.number().int().positive().optional(),
    story_completion_min_summaries: z.number().int().positive().optional(),
    story_completion_sweep_interval_ms: z.number().int().positive().optional(),
    story_narrative_max_chars: z.number().int().positive().optional(),
    story_timeout_ms: z.number().int().positive().optional(),
    fallback_timeout_ms: z.number().int().positive().optional(),
    story_fold_failure_cooldown_ms: z.number().int().positive().optional(),
    catch_up_interval_ms: z.number().int().positive().optional(),
    catch_up_window_hours: z.number().int().positive().optional(),
    catch_up_max_jobs_per_round: z.number().int().positive().optional(),
    provider: z.enum(["codex", "openai-api"]).optional(),
    model: z.string().trim().min(1).optional(),
    story_model: z.string().trim().min(1).optional(),
    preferred_model_presets: z.array(z.string().trim().min(1)).optional(),
    reasoning_effort: z.enum([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]).optional(),
    instruction_extraction_model: z.string().trim().min(1).optional(),
    instruction_extraction_reasoning_effort: z.enum([
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

const TurnSummaryFileConfigSchema = TurnSummaryConfigFileSchema
  .transform((value) => ({
    enabled: value.enabled,
    instruction: value.instruction,
    storyInstruction: value.story_instruction,
    storyFoldThreshold: value.story_fold_threshold,
    storyFoldBatchSize: value.story_fold_batch_size,
    storyFoldMaxBatchesPerRun: value.story_fold_max_batches_per_run,
    storyCompletedFoldMaxSummaries: value.story_completed_fold_max_summaries,
    storyCompletionGraceMs: value.story_completion_grace_ms,
    storyCompletionMinSummaries: value.story_completion_min_summaries,
    storyCompletionSweepIntervalMs: value.story_completion_sweep_interval_ms,
    storyNarrativeMaxChars: value.story_narrative_max_chars,
    storyTimeoutMs: value.story_timeout_ms,
    fallbackTimeoutMs: value.fallback_timeout_ms,
    storyFoldFailureCooldownMs: value.story_fold_failure_cooldown_ms,
    catchUpIntervalMs: value.catch_up_interval_ms,
    catchUpWindowHours: value.catch_up_window_hours,
    catchUpMaxJobsPerRound: value.catch_up_max_jobs_per_round,
    provider: value.provider,
    model: value.model!,
    storyModel: value.story_model ?? value.model!,
    reasoningEffort: value.reasoning_effort,
    instructionExtractionReasoningEffort:
      value.instruction_extraction_reasoning_effort,
    timeoutMs: value.timeout_ms,
    maxAttempts: value.max_attempts,
    codexConcurrencyLimit: value.codex_concurrency_limit,
    codepointLimit: value.codepoint_limit,
    historyLimit: value.history_limit,
    excludedFolderIds: value.excluded_folder_ids,
  }));

export type TurnSummaryStage = {
  readonly backend: "claude" | "antigravity" | "codex";
  readonly model: string;
};

type TurnSummaryFileConfig = z.output<typeof TurnSummaryFileConfigSchema>;

/**
 * Everything the config file decides. Whether turn and session summaries run and which model
 * stages they use come from the summary settings store; the file's `enabled`,
 * `preferred_model_presets` and the catalogue's `turn_summary_preferred` only seed that store once.
 */
export type TurnSummaryConfig = Omit<TurnSummaryFileConfig, "enabled" | "storyModel"> & {
  readonly turnEnabled: boolean;
  readonly sessionEnabled: boolean;
  readonly turnStages: readonly TurnSummaryStage[];
  readonly sessionStages: readonly TurnSummaryStage[];
};

type Catalog = ReturnType<ModelCatalogSource["snapshot"]>;

type LoadedFileConfig = {
  readonly file: TurnSummaryFileConfig;
  readonly preferredPresetIds: readonly string[];
  readonly catalog: Catalog;
};

function loadFileConfig(configPath: string, modelCatalog: ModelCatalogSource): LoadedFileConfig {
  const source = readFileSync(configPath, "utf8");
  const base = TurnSummaryConfigFileSchema.parse(parse(source));
  const localConfigPath = resolveLocalConfigPath(configPath);
  const overlay = existsSync(localConfigPath)
    ? TurnSummaryConfigOverlaySchema.parse(
      parse(readFileSync(localConfigPath, "utf8")),
    )
    : {};
  const catalog = modelCatalog.snapshot();
  const provider = overlay.provider ?? base.provider;
  const resolveTaskModel = (presetId: string, expectedBackend: typeof provider): string => {
    const preset = resolveModelPreset(catalog, presetId);
    if (preset.backend !== expectedBackend) {
      throw new Error(`Task model preset backend ${preset.backend} does not match provider ${expectedBackend}`);
    }
    return preset.model;
  };
  const defaults = catalog.task_defaults;
  const merged = { ...base, ...overlay };
  const file = TurnSummaryFileConfigSchema.parse({
    ...merged,
    model: merged.model ?? resolveTaskModel(defaults.turn_summary.model_preset, provider),
    story_model: merged.story_model ?? (base.model === undefined
      ? resolveTaskModel(defaults.turn_story.model_preset, "codex") : merged.model),
  });
  const preferredPresetIds = merged.preferred_model_presets
    ?? defaults.turn_summary_preferred?.model_presets
    ?? [];
  return { file, preferredPresetIds, catalog };
}

export class TurnSummaryConfigService {
  private lastSuccessful: Omit<TurnSummaryConfig, "turnEnabled" | "sessionEnabled" | "turnStages" | "sessionStages"> | undefined;
  private readonly warnedPresets = new Set<string>();

  constructor(
    private readonly configPath: string,
    private readonly logger: TurnSummaryLogger,
    private readonly modelCatalog: ModelCatalogSource,
    private readonly summarySettings: SummarySettingsReader,
  ) {}

  read(): TurnSummaryConfig {
    const fileConfig = this.readFileConfig();
    const settings = this.summarySettings.current();
    const catalog = this.modelCatalog.snapshot();
    return {
      ...fileConfig,
      turnEnabled: settings.turn.enabled,
      sessionEnabled: settings.session.enabled,
      turnStages: this.resolveStages(catalog, settings.turn.model_presets),
      sessionStages: this.resolveStages(catalog, settings.session.model_presets),
    };
  }

  private readFileConfig() {
    try {
      const { file } = loadFileConfig(this.configPath, this.modelCatalog);
      const { enabled: _enabled, storyModel: _storyModel, ...config } = file;
      this.lastSuccessful = config;
      return config;
    } catch (error) {
      if (this.lastSuccessful === undefined) throw error;
      this.logger.warn(
        { err: error, configPath: this.configPath },
        "Invalid turn summary config update; keeping the last successful config",
      );
      return this.lastSuccessful;
    }
  }

  /** A stored preset the catalogue no longer offers is skipped with one warning instead of failing every read. */
  private resolveStages(catalog: Catalog, presetIds: readonly string[]): TurnSummaryStage[] {
    const stages: TurnSummaryStage[] = [];
    for (const presetId of presetIds) {
      const preset = catalog.presets.find((entry) => entry.id === presetId);
      if (preset === undefined || !isSelectableSummaryPreset(preset)) {
        if (!this.warnedPresets.has(presetId)) {
          this.warnedPresets.add(presetId);
          this.logger.warn({ presetId }, "Summary settings name a model preset that cannot be used; skipping it");
        }
        continue;
      }
      stages.push({ backend: preset.backend as TurnSummaryStage["backend"], model: preset.model });
    }
    return stages;
  }
}

/**
 * The value to store the first time summaries are found enabled in the config file, laid out as the
 * model order the previous chain actually ran. Undefined when the file leaves summaries off.
 */
export function readSummarySettingsSeed(
  configPath: string,
  modelCatalog: ModelCatalogSource,
): SummarySettingsValue | undefined {
  const { file, preferredPresetIds, catalog } = loadFileConfig(configPath, modelCatalog);
  if (!file.enabled) return undefined;
  const codexPresetFor = (model: string, taskPresetId: string): string =>
    catalog.presets.find((preset: ModelPreset) => preset.backend === "codex" && preset.model === model)?.id
      ?? taskPresetId;
  const preferred = preferredPresetIds.map((presetId) => resolveModelPreset(catalog, presetId));
  const turnCodex = codexPresetFor(file.model, catalog.task_defaults.turn_summary.model_preset);
  const sessionCodex = codexPresetFor(file.storyModel, catalog.task_defaults.turn_story.model_preset);
  return {
    turn: { enabled: true, model_presets: [...preferred.map((preset) => preset.id), turnCodex] },
    session: {
      enabled: true,
      model_presets: [
        ...preferred.filter((preset) => preset.backend !== "antigravity").map((preset) => preset.id),
        sessionCodex,
      ],
    },
  };
}

function resolveLocalConfigPath(configPath: string): string {
  const extension = extname(configPath);
  return join(
    dirname(configPath),
    `${basename(configPath, extension)}.local${extension}`,
  );
}
