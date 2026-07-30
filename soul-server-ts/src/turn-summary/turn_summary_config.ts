import { readFileSync } from "node:fs";

import type { Logger } from "pino";
import { parse } from "yaml";
import { z } from "zod";

const TurnSummaryConfigSchema = z
  .object({
    provider: z.enum(["codex", "openai-api"]),
    model: z.string().trim().min(1),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]),
    timeout_ms: z.number().int().positive(),
    max_attempts: z.number().int().min(1).max(2),
    codepoint_limit: z.number().int().positive(),
    history_limit: z.number().int().min(0).max(5),
    excluded_folder_ids: z.array(z.string().uuid()),
  })
  .transform((value) => ({
    provider: value.provider,
    model: value.model,
    reasoningEffort: value.reasoning_effort,
    timeoutMs: value.timeout_ms,
    maxAttempts: value.max_attempts,
    codepointLimit: value.codepoint_limit,
    historyLimit: value.history_limit,
    excludedFolderIds: value.excluded_folder_ids,
  }));

export type TurnSummaryConfig = z.infer<typeof TurnSummaryConfigSchema>;

export class TurnSummaryConfigService {
  private lastSuccessful: TurnSummaryConfig | undefined;

  constructor(
    private readonly configPath: string,
    private readonly logger: Logger,
  ) {}

  read(): TurnSummaryConfig {
    try {
      const source = readFileSync(this.configPath, "utf8");
      const config = TurnSummaryConfigSchema.parse(parse(source));
      this.lastSuccessful = config;
      return config;
    } catch (err) {
      if (!this.lastSuccessful) throw err;
      this.logger.warn(
        { err, configPath: this.configPath },
        "Invalid turn summary config update; keeping the last successful config",
      );
      return this.lastSuccessful;
    }
  }
}
