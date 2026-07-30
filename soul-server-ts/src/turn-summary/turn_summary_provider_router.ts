import type { Logger } from "pino";

import { createOpenAiApiTurnSummarizer } from "./openai_api_turn_summarizer.js";
import type { TurnSummaryConfig } from "./turn_summary_config.js";
import type {
  TurnSummarizer,
  TurnSummaryInput,
  TurnSummaryResult,
} from "./turn_summarizer.js";

export class TurnSummaryProviderUnavailableError extends Error {
  readonly silent = true;

  constructor(readonly provider: TurnSummaryConfig["provider"]) {
    super(`Turn summary provider is unavailable: ${provider}`);
    this.name = "TurnSummaryProviderUnavailableError";
  }
}

export class TurnSummaryProviderRouter implements TurnSummarizer {
  constructor(private readonly providers: {
    codex: TurnSummarizer;
    openaiApi?: TurnSummarizer;
  }) {}

  async summarize(
    input: TurnSummaryInput,
    config: TurnSummaryConfig,
  ): Promise<TurnSummaryResult> {
    if (config.provider === "codex") {
      return await this.providers.codex.summarize(input, config);
    }
    if (!this.providers.openaiApi) {
      throw new TurnSummaryProviderUnavailableError("openai-api");
    }
    return await this.providers.openaiApi.summarize(input, config);
  }
}

export function createTurnSummaryProviderRouter(options: {
  codex: TurnSummarizer;
  openAiApiKey?: string;
  logger: Pick<Logger, "info">;
  createOpenAiApi?: (apiKey: string) => TurnSummarizer;
}): TurnSummaryProviderRouter {
  if (!options.openAiApiKey) {
    options.logger.info(
      "OpenAI API turn-summary provider disabled: TURN_SUMMARY_OPENAI_KEY is unset",
    );
    return new TurnSummaryProviderRouter({ codex: options.codex });
  }
  const createOpenAiApi = options.createOpenAiApi ??
    ((apiKey: string) => createOpenAiApiTurnSummarizer({ apiKey }));
  return new TurnSummaryProviderRouter({
    codex: options.codex,
    openaiApi: createOpenAiApi(options.openAiApiKey),
  });
}

export function isTurnSummaryProviderUnavailableError(
  error: unknown,
): error is TurnSummaryProviderUnavailableError {
  return error instanceof TurnSummaryProviderUnavailableError;
}
