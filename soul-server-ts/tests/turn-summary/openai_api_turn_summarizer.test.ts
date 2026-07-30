import { describe, expect, it, vi } from "vitest";

import {
  OPENAI_API_TURN_SUMMARY_MODEL,
  OpenAiApiTurnSummarizer,
  createOpenAiApiTurnSummarizer,
  type OpenAiChatCompletionPort,
} from "../../src/turn-summary/openai_api_turn_summarizer.js";

const config = {
  provider: "openai-api" as const,
  model: "ignored-on-api-path",
  reasoningEffort: "high" as const,
  timeoutMs: 30_000,
  maxAttempts: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [],
};

describe("createOpenAiApiTurnSummarizer", () => {
  it("passes only the dedicated key explicitly and disables SDK retries", () => {
    const execute = vi.fn<OpenAiChatCompletionPort["execute"]>();
    const createClient = vi.fn(() => ({ execute }));

    createOpenAiApiTurnSummarizer({
      apiKey: "turn-summary-only",
      createClient,
    });

    expect(createClient).toHaveBeenCalledWith({
      apiKey: "turn-summary-only",
      maxRetries: 0,
    });
  });
});

describe("OpenAiApiTurnSummarizer", () => {
  it("uses chat.completions at temperature zero and maps available usage", async () => {
    const execute = vi.fn<OpenAiChatCompletionPort["execute"]>()
      .mockResolvedValue({
        choices: [{ message: { content: "API 요약" } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      });
    const summarizer = new OpenAiApiTurnSummarizer({
      client: { execute },
      nowMs: (() => {
        let now = 100;
        return () => (now += 25);
      })(),
    });

    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "결과",
      previousSummaries: ["직전 요약"],
    }, config)).resolves.toEqual({
      content: "API 요약",
      model: OPENAI_API_TURN_SUMMARY_MODEL,
      latencyMs: 25,
      attempts: 1,
      usage: {
        input_tokens: 12,
        cached_input_tokens: 4,
        output_tokens: 5,
        reasoning_output_tokens: 2,
      },
    });
    expect(execute).toHaveBeenCalledWith({
      model: "gpt-5.4-mini",
      temperature: 0,
      messages: [{
        role: "user",
        content: expect.stringContaining("직전 요약"),
      }],
    }, {
      timeout: 30_000,
      maxRetries: 0,
    });
  });

  it("retries once in the summarizer layer", async () => {
    const execute = vi.fn<OpenAiChatCompletionPort["execute"]>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "재시도 성공" } }],
      });
    const summarizer = new OpenAiApiTurnSummarizer({
      client: { execute },
      nowMs: (() => {
        let now = 100;
        return () => (now += 25);
      })(),
    });

    await expect(summarizer.summarize({
      userText: "요청",
      assistantText: "결과",
      previousSummaries: [],
    }, config)).resolves.toMatchObject({
      content: "재시도 성공",
      attempts: 2,
      latencyMs: 25,
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
