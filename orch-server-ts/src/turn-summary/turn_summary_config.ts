import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { z } from "zod";

export type TurnSummaryLogger = {
  readonly info?: (...args: unknown[]) => void;
  readonly warn: (...args: unknown[]) => void;
};

const TurnSummaryConfigSchema = z
  .object({
    enabled: z.boolean(),
    instruction: z.string().trim().min(1),
    provider: z.enum(["codex", "openai-api"]),
    model: z.string().trim().min(1),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    timeout_ms: z.number().int().positive(),
    max_attempts: z.number().int().min(1).max(2),
    codex_concurrency_limit: z.number().int().positive(),
    codepoint_limit: z.number().int().positive(),
    history_limit: z.number().int().min(0).max(5),
    excluded_folder_ids: z.array(z.string().uuid()),
  })
  .strict()
  .transform((value) => ({
    enabled: value.enabled,
    instruction: value.instruction,
    provider: value.provider,
    model: value.model,
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
      const config = TurnSummaryConfigSchema.parse(parse(source));
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
