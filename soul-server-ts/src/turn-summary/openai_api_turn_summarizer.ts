import OpenAI from "openai";

import type { TurnSummaryConfig } from "./turn_summary_config.js";
import {
  buildTurnSummaryPrompt,
  type TurnSummarizer,
  type TurnSummaryInput,
  type TurnSummaryResult,
  type TurnSummaryUsage,
} from "./turn_summarizer.js";

export const OPENAI_API_TURN_SUMMARY_MODEL = "gpt-5.4-mini";

export interface OpenAiChatCompletionRequest {
  model: typeof OPENAI_API_TURN_SUMMARY_MODEL;
  temperature: 0;
  messages: [{ role: "user"; content: string }];
}

export interface OpenAiChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface OpenAiChatCompletionPort {
  execute(
    request: OpenAiChatCompletionRequest,
    options: { timeout: number; maxRetries: 0 },
  ): Promise<OpenAiChatCompletionResponse>;
}

export interface OpenAiApiTurnSummarizerOptions {
  client: OpenAiChatCompletionPort;
  nowMs?: () => number;
}

export class OpenAiApiTurnSummarizer implements TurnSummarizer {
  private readonly nowMs: () => number;

  constructor(private readonly options: OpenAiApiTurnSummarizerOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async summarize(
    input: TurnSummaryInput,
    config: TurnSummaryConfig,
  ): Promise<TurnSummaryResult> {
    const startedAt = this.nowMs();
    const prompt = buildTurnSummaryPrompt(input, config);
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        const completion = await this.options.client.execute({
          model: OPENAI_API_TURN_SUMMARY_MODEL,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }, {
          timeout: config.timeoutMs,
          maxRetries: 0,
        });
        const content = completion.choices[0]?.message.content?.trim();
        if (!content) throw new Error("OpenAI chat completion produced no content");
        const usage = mapOpenAiUsage(completion.usage);
        return {
          content,
          model: OPENAI_API_TURN_SUMMARY_MODEL,
          latencyMs: Math.max(0, this.nowMs() - startedAt),
          attempts: attempt,
          ...(usage ? { usage } : {}),
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw new OpenAiTurnSummaryExecutionError(
      config.maxAttempts,
      Math.max(0, this.nowMs() - startedAt),
      lastError,
    );
  }
}

export class OpenAiTurnSummaryExecutionError extends Error {
  constructor(
    readonly attempts: number,
    readonly latencyMs: number,
    cause: unknown,
  ) {
    super(`OpenAI turn summary failed after ${attempts} attempts`, { cause });
    this.name = "OpenAiTurnSummaryExecutionError";
  }
}

export function createOpenAiApiTurnSummarizer(options: {
  apiKey: string;
  createClient?: (config: {
    apiKey: string;
    maxRetries: 0;
  }) => OpenAiChatCompletionPort;
}): OpenAiApiTurnSummarizer {
  const createClient = options.createClient ?? defaultOpenAiClientFactory;
  return new OpenAiApiTurnSummarizer({
    client: createClient({
      apiKey: options.apiKey,
      maxRetries: 0,
    }),
  });
}

function defaultOpenAiClientFactory(config: {
  apiKey: string;
  maxRetries: 0;
}): OpenAiChatCompletionPort {
  const client = new OpenAI(config);
  return {
    execute: async (request, options) =>
      client.chat.completions.create(request, options),
  };
}

function mapOpenAiUsage(
  value: OpenAiChatCompletionResponse["usage"],
): TurnSummaryUsage | undefined {
  if (!value) return undefined;
  const usage: TurnSummaryUsage = {};
  if (typeof value.prompt_tokens === "number") {
    usage.input_tokens = value.prompt_tokens;
  }
  if (typeof value.prompt_tokens_details?.cached_tokens === "number") {
    usage.cached_input_tokens = value.prompt_tokens_details.cached_tokens;
  }
  if (typeof value.completion_tokens === "number") {
    usage.output_tokens = value.completion_tokens;
  }
  if (typeof value.completion_tokens_details?.reasoning_tokens === "number") {
    usage.reasoning_output_tokens =
      value.completion_tokens_details.reasoning_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
