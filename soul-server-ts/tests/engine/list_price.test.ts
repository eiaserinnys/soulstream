import { describe, expect, it } from "vitest";

import {
  claudeTurnCostUsd,
  codexTurnCostUsd,
  LIST_PRICES,
  normalizePricedModelId,
} from "../../src/engine/list_price.js";

describe("list price turn cost", () => {
  it("keeps the approved model price rows", () => {
    expect(LIST_PRICES).toEqual({
      "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 },
      "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 },
      "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
      "claude-sonnet-5-5": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
      "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
      "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
      "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
      "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.125, output: 0.5 },
      "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 10 },
      "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 10 },
      "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 12.5, output: 50 },
    });
  });

  it("calculates the supplied Claude vectors and rounds to six decimal places", () => {
    const v1 = {
      input_tokens: 4,
      cache_read_input_tokens: 245_563,
      cache_creation_input_tokens: 1_141,
      output_tokens: 272,
    };
    const v4 = {
      input_tokens: 48,
      output_tokens: 15_972,
      cache_creation: { ephemeral_1h_input_tokens: 104_313, ephemeral_5m_input_tokens: 0 },
      cache_read_input_tokens: 1_971_030,
      cache_creation_input_tokens: 104_313,
    };
    const v5 = {
      input_tokens: 6,
      cache_read_input_tokens: 637_594,
      cache_creation_input_tokens: 7_767,
      output_tokens: 6_139,
    };

    expect(claudeTurnCostUsd(v1, "claude-opus-5-5")).toBe(0.063697);
    expect(claudeTurnCostUsd(v1, "claude-sonnet-5")).toBe(0.056405);
    expect(claudeTurnCostUsd(v4, "claude-opus-5-5")).toBe(1.548342);
    expect(claudeTurnCostUsd(v5, "claude-fable-5-1")).toBe(0.621749);
  });

  it("calculates the supplied Codex vectors without adding reasoning tokens", () => {
    const v6 = { input_tokens: 14_124, cached_input_tokens: 12_288, output_tokens: 5 };
    const v7 = { input_tokens: 120_092, cached_input_tokens: 68_992, output_tokens: 493 };

    expect(codexTurnCostUsd(v6, "gpt-6.1-sol")).toBe(0.004951);
    expect(codexTurnCostUsd(v6, "gpt-6-luna")).toBe(0.000309);
    expect(codexTurnCostUsd(v6, "gpt-6-sol")).toBe(0.00618);
    expect(codexTurnCostUsd(v6, "gpt-6-astra")).toBe(0.030898);
    expect(codexTurnCostUsd(v7, "gpt-6.1-sol")).toBe(0.114029);
  });

  it("normalizes only dated and bracketed suffixes before exact model matching", () => {
    expect(normalizePricedModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizePricedModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
    expect(normalizePricedModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizePricedModelId("gpt-6-sol")).toBe("gpt-6-sol");
    expect(normalizePricedModelId("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(claudeTurnCostUsd({ input_tokens: 1, output_tokens: 0 }, "claude-opus-5-5"))
      .toBe(0.000004);
    expect(claudeTurnCostUsd({ input_tokens: 1, output_tokens: 0 }, "claude-opus-5"))
      .toBe(0.000005);
    expect(codexTurnCostUsd({ input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 0 }, "gpt-6-sol"))
      .toBe(0.002);
    expect(codexTurnCostUsd({ input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 0 }, "gpt-6.1-sol"))
      .toBe(0.001);
  });

  it("prices Claude 5-minute cache writes separately from the one-hour remainder", () => {
    expect(claudeTurnCostUsd({
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
      output_tokens: 0,
    }, "claude-opus-5-5")).toBe(0.005);
  });

  it("omits prices for unknown models and non-record Claude usage", () => {
    expect(claudeTurnCostUsd({ input_tokens: 1, output_tokens: 1 }, "claude-opus-5-7"))
      .toBeUndefined();
    expect(codexTurnCostUsd({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, "gpt-5.6-sol"))
      .toBeUndefined();
    expect(claudeTurnCostUsd(null, "claude-opus-5-5")).toBeUndefined();
  });
});
