import { describe, expect, it } from "vitest";

import {
  buildContextPromptTokenMetrics,
  estimatePromptTokens,
  formatPromptTokenCount,
  systemPromptTokenScope,
} from "./prompt-token-metrics";

describe("prompt-token-metrics", () => {
  it("estimates empty prompt values as zero", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens(null)).toBe(0);
  });

  it("counts ASCII runs by approximate BPE chunks", () => {
    expect(estimatePromptTokens("abcdefgh")).toBe(2);
    expect(estimatePromptTokens("hello world")).toBe(4);
  });

  it("counts Korean characters as visible prompt tokens", () => {
    expect(estimatePromptTokens("안녕")).toBe(2);
  });

  it("serializes context items with prompt XML wrappers before counting", () => {
    const metrics = buildContextPromptTokenMetrics([
      { key: "soulstream-session", label: "Session", content: { id: "sess-1" } },
      { key: "empty", label: "Empty", content: "" },
    ]);

    expect(metrics.items).toHaveLength(2);
    expect(metrics.items[0].tokens).toBeGreaterThan(0);
    expect(metrics.items[1].tokens).toBe(0);
    expect(metrics.totalTokens).toBeGreaterThan(metrics.items[0].tokens);
  });

  it("formats approximate token labels", () => {
    expect(formatPromptTokenCount(1234)).toBe("~1,234 tokens");
  });

  it("codex system prompt is displayed as prompt tokens", () => {
    expect(systemPromptTokenScope("codex")).toBe("prompt");
    expect(systemPromptTokenScope("claude")).toBe("system");
    expect(systemPromptTokenScope(undefined)).toBe("system");
  });
});
