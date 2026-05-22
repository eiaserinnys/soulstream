import { z } from "zod";

import type { CallerInfo } from "../task/task_models.js";

export const LlmProviderSchema = z.enum(["openai", "anthropic"]);
export type LlmProvider = z.infer<typeof LlmProviderSchema>;

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export const LlmCompletionRequestSchema = z.object({
  provider: LlmProviderSchema,
  model: z.string().min(1),
  messages: z.array(LlmMessageSchema).min(1),
  max_tokens: z.number().int().min(1).default(2048),
  temperature: z.number().min(0).max(2).nullable().optional().default(null),
  client_id: z.string().nullable().optional().default(null),
  caller_info: z.record(z.string(), z.unknown()).nullable().optional().default(null),
});

export interface LlmCompletionRequest {
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  max_tokens: number;
  temperature: number | null;
  client_id: string | null;
  caller_info: CallerInfo | null;
}

export interface LlmCompletionResponse {
  session_id: string;
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  model: string;
  provider: LlmProvider;
}

export interface LlmResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmAdapter {
  complete(params: {
    model: string;
    messages: LlmMessage[];
    maxTokens: number;
    temperature: number | null;
  }): Promise<LlmResult>;
}

export function parseLlmCompletionRequest(input: unknown): LlmCompletionRequest {
  const parsed = LlmCompletionRequestSchema.parse(input);
  return {
    provider: parsed.provider,
    model: parsed.model,
    messages: parsed.messages,
    max_tokens: parsed.max_tokens,
    temperature: parsed.temperature,
    client_id: parsed.client_id,
    caller_info: parsed.caller_info as CallerInfo | null,
  };
}
