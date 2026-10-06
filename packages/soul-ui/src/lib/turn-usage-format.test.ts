import { describe, expect, it } from "vitest";

import {
  formatContextUsageText,
  formatTurnCompleteStats,
  formatTurnUsageCaptionTitle,
} from "./turn-usage-format";

describe("formatTurnCompleteStats", () => {
  it("formats the V1 Claude token and price vector", () => {
    expect(formatTurnCompleteStats({
      usage: {
        input_tokens: 4,
        output_tokens: 272,
        cache_read_input_tokens: 245_563,
        cache_creation_input_tokens: 1_141,
      },
      turnCostUsd: 0.063697,
    })).toBe("입력 246,708 (캐시 246,704) · 출력 272 · 정가 $0.06");
  });

  it("formats the V5 Claude turn and session totals", () => {
    expect(formatTurnCompleteStats({
      usage: {
        input_tokens: 6,
        output_tokens: 6_139,
        cache_read_input_tokens: 637_594,
        cache_creation_input_tokens: 7_767,
      },
      turnCostUsd: 0.621749,
      sessionCostUsd: 17.91,
    })).toBe("입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $17.91)");
  });

  it("formats the V6 Codex cached-input and sub-cent price", () => {
    expect(formatTurnCompleteStats({
      usage: { input_tokens: 14_124, cached_input_tokens: 12_288, output_tokens: 5 },
      turnCostUsd: 0.004951,
      sessionCostUsd: 0.004951,
    })).toBe("입력 14,124 (캐시 12,288) · 출력 5 · 정가 <$0.01 (세션 <$0.01)");
  });

  it("omits a V9 price when the model has no price entry", () => {
    expect(formatTurnCompleteStats({
      usage: { input_tokens: 14_124, cached_input_tokens: 12_288, output_tokens: 5 },
    })).toBe("입력 14,124 (캐시 12,288) · 출력 5");
  });

  it("marks the V10 partial session total with a plus", () => {
    expect(formatTurnCompleteStats({
      usage: {
        input_tokens: 6,
        output_tokens: 6_139,
        cache_read_input_tokens: 637_594,
        cache_creation_input_tokens: 7_767,
      },
      turnCostUsd: 0.621749,
      sessionCostUsd: 3.2,
      sessionCostPartial: true,
    })).toBe("입력 645,367 (캐시 645,361) · 출력 6,139 · 정가 $0.62 (세션 $3.20+)");
  });

  it("adds thousands separators to rounded price values", () => {
    expect(formatTurnCompleteStats({
      turnCostUsd: 0.62,
      sessionCostUsd: 1234.56,
    })).toBe("정가 $0.62 (세션 $1,234.56)");
    expect(formatTurnCompleteStats({ turnCostUsd: 1000 })).toBe("정가 $1,000.00");
    expect(formatTurnCompleteStats({
      turnCostUsd: 0.62,
      sessionCostUsd: 999.995,
    })).toBe("정가 $0.62 (세션 $1,000.00)");
    expect(formatTurnCompleteStats({
      turnCostUsd: 0.62,
      sessionCostUsd: 1234567.891,
      sessionCostPartial: true,
    })).toBe("정가 $0.62 (세션 $1,234,567.89+)");
  });

  it("omits a zero cache and only emits finite usage chunks", () => {
    expect(formatTurnCompleteStats({
      usage: { input_tokens: 10, output_tokens: 0 },
    })).toBe("입력 10 · 출력 0");
    expect(formatTurnCompleteStats({ turnCostUsd: 0 })).toBe("정가 $0.00");
    expect(formatTurnCompleteStats({ sessionCostUsd: 2 })).toBeUndefined();
    expect(formatTurnCompleteStats({})).toBeUndefined();
  });
});

describe("formatContextUsageText", () => {
  it("formats actual and estimated context vectors", () => {
    expect(formatContextUsageText({
      usedTokens: 326_300,
      maxTokens: 1_000_000,
      percent: 32.6,
    })).toBe("컨텍스트 326,300 / 1,000,000 (32.6%)");
    expect(formatContextUsageText({
      usedTokens: 14_223,
      maxTokens: 1_000_000,
      percent: 1.4,
      estimated: true,
    })).toBe("컨텍스트 약 14,223 / 1,000,000 (1.4%)");
  });

  it("omits a non-finite percent and requires finite usage bounds", () => {
    expect(formatContextUsageText({
      usedTokens: 1,
      maxTokens: 10,
      percent: Number.NaN,
      estimated: true,
    })).toBe("컨텍스트 약 1 / 10");
    expect(formatContextUsageText({ usedTokens: Number.NaN, maxTokens: 10 })).toBeUndefined();
  });
});

describe("formatTurnUsageCaptionTitle", () => {
  it("formats context percentage and turn price", () => {
    expect(formatTurnUsageCaptionTitle({ percent: 32.6, turnCostUsd: 0.62 }))
      .toBe("컨텍스트 32.6% · 정가 $0.62");
  });

  it("formats the turn price without a session total", () => {
    expect(formatTurnUsageCaptionTitle({ turnCostUsd: 0.07, usage: { input_tokens: 8, output_tokens: 2 } }))
      .toBe("정가 $0.07");
  });

  it("formats estimated context percentage", () => {
    expect(formatTurnUsageCaptionTitle({ percent: 1.4, estimated: true }))
      .toBe("컨텍스트 약 1.4%");
  });

  it("falls back to input and output token stats", () => {
    expect(formatTurnUsageCaptionTitle({ usage: { input_tokens: 12, output_tokens: 3 } }))
      .toBe("입력 12 · 출력 3");
  });

  it("returns undefined when no title data is available", () => {
    expect(formatTurnUsageCaptionTitle({})).toBeUndefined();
  });
});
