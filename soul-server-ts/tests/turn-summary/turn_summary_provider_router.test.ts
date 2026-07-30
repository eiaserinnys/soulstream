import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  TurnSummaryProviderRouter,
  TurnSummaryProviderUnavailableError,
  createTurnSummaryProviderRouter,
} from "../../src/turn-summary/turn_summary_provider_router.js";
import type {
  TurnSummarizer,
  TurnSummaryInput,
  TurnSummaryResult,
} from "../../src/turn-summary/turn_summarizer.js";

const input: TurnSummaryInput = {
  userText: "요청",
  assistantText: "결과",
  previousSummaries: [],
};
const baseConfig = {
  model: "gpt-5.6-terra",
  reasoningEffort: "high" as const,
  timeoutMs: 30_000,
  maxAttempts: 2,
  codepointLimit: 6_000,
  historyLimit: 5,
  excludedFolderIds: [],
};
const result: TurnSummaryResult = {
  content: "요약",
  model: "gpt-5.6-terra",
  latencyMs: 10,
  attempts: 1,
};

function mockSummarizer(): TurnSummarizer {
  return { summarize: vi.fn().mockResolvedValue(result) };
}

describe("TurnSummaryProviderRouter", () => {
  it("routes each hot-loaded provider to exactly one implementation", async () => {
    const codex = mockSummarizer();
    const openaiApi = mockSummarizer();
    const router = new TurnSummaryProviderRouter({ codex, openaiApi });

    await router.summarize(input, { ...baseConfig, provider: "codex" });
    await router.summarize(input, { ...baseConfig, provider: "openai-api" });

    expect(codex.summarize).toHaveBeenCalledTimes(1);
    expect(openaiApi.summarize).toHaveBeenCalledTimes(1);
  });

  it("marks the optional API provider unavailable without falling back", async () => {
    const codex = mockSummarizer();
    const router = new TurnSummaryProviderRouter({ codex });

    await expect(router.summarize(
      input,
      { ...baseConfig, provider: "openai-api" },
    )).rejects.toBeInstanceOf(TurnSummaryProviderUnavailableError);
    expect(codex.summarize).not.toHaveBeenCalled();
  });
});

describe("createTurnSummaryProviderRouter", () => {
  it("logs once and does not create an API client when the optional key is absent", () => {
    const info = vi.fn();
    const logger = pino({ level: "silent" });
    Object.assign(logger, { info });
    const createOpenAiApi = vi.fn();

    createTurnSummaryProviderRouter({
      codex: mockSummarizer(),
      logger,
      createOpenAiApi,
    });

    expect(createOpenAiApi).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("passes the dedicated key to the API summarizer factory", () => {
    const logger = pino({ level: "silent" });
    const api = mockSummarizer();
    const createOpenAiApi = vi.fn(() => api);

    createTurnSummaryProviderRouter({
      codex: mockSummarizer(),
      openAiApiKey: "turn-summary-only",
      logger,
      createOpenAiApi,
    });

    expect(createOpenAiApi).toHaveBeenCalledWith("turn-summary-only");
  });
});
