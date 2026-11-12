import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import {
  priceInferenceUsage,
  priceInferenceUsageComponents,
} from "@soulstream/model-catalog/inference-pricing";

import {
  antigravityTurnCostUsd,
  claudeTurnCostUsd,
  codexTurnCostUsd,
  normalizePricedModelId,
} from "../../src/engine/list_price.js";

const catalog = parseModelCatalogYaml(fs.readFileSync(
  fileURLToPath(new URL("../../../packages/model-catalog/data/model-catalog.yaml", import.meta.url)),
  "utf-8",
));

describe("list price turn cost", () => {
  it("exposes the fixed pricing snapshot through the catalog", () => {
    expect(catalog.price_snapshot.price_version).toBe("api-list-usd-2026-10-19-v1");
    expect(priceInferenceUsage(catalog, {
      provider: "claude",
      model: "claude-opus-5-5",
      input_total: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 0,
    }).price_version).toBe("api-list-usd-2026-10-19-v1");
  });

  it("prices only explicitly timed Claude cache writes through the legacy wrapper", () => {
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

    expect(claudeTurnCostUsd(catalog, v1, "claude-opus-5-5")).toBeUndefined();
    expect(claudeTurnCostUsd(catalog, v1, "claude-sonnet-5")).toBeUndefined();
    expect(claudeTurnCostUsd(catalog, v4, "claude-opus-5-5")).toBe(1.548342);
    expect(claudeTurnCostUsd(catalog, v5, "claude-fable-5-1")).toBeUndefined();
  });

  it("calculates the supplied Codex vectors without adding reasoning tokens", () => {
    const v6 = { input_tokens: 14_124, cached_input_tokens: 12_288, output_tokens: 5 };
    const v7 = { input_tokens: 120_092, cached_input_tokens: 68_992, output_tokens: 493 };

    expect(codexTurnCostUsd(catalog, v6, "gpt-6.1-sol")).toBe(0.004951);
    expect(codexTurnCostUsd(catalog, v6, "gpt-6-luna")).toBe(0.000309);
    expect(codexTurnCostUsd(catalog, v6, "gpt-6-sol")).toBe(0.00618);
    expect(codexTurnCostUsd(catalog, v6, "gpt-6-astra")).toBe(0.030898);
    expect(codexTurnCostUsd(catalog, v7, "gpt-6.1-sol")).toBe(0.114029);
  });

  it("normalizes only dated and bracketed suffixes before exact model matching", () => {
    expect(normalizePricedModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizePricedModelId("claude-fable-5-2[1m]")).toBe("claude-fable-5-2");
    expect(normalizePricedModelId("claude-fable-5-1[1m]")).toBe("claude-fable-5-1");
    expect(normalizePricedModelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizePricedModelId("gpt-6-sol")).toBe("gpt-6-sol");
    expect(normalizePricedModelId("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(claudeTurnCostUsd(catalog, { input_tokens: 1, output_tokens: 0 }, "claude-opus-5-5"))
      .toBe(0.000004);
    expect(claudeTurnCostUsd(catalog, { input_tokens: 1, output_tokens: 0 }, "claude-opus-5"))
      .toBe(0.000005);
    expect(codexTurnCostUsd(catalog, { input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 0 }, "gpt-6-sol"))
      .toBe(0.002);
    expect(codexTurnCostUsd(catalog, { input_tokens: 10_000, cached_input_tokens: 10_000, output_tokens: 0 }, "gpt-6.1-sol"))
      .toBe(0.001);
  });

  it("prices Claude 5-minute cache writes separately from the one-hour remainder", () => {
    expect(claudeTurnCostUsd(catalog, {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
      output_tokens: 0,
    }, "claude-opus-5-5")).toBe(0.005);
  });

  it("omits prices for unknown models and non-record Claude usage", () => {
    expect(claudeTurnCostUsd(catalog, { input_tokens: 1, output_tokens: 1 }, "claude-opus-5-7"))
      .toBeUndefined();
    expect(codexTurnCostUsd(catalog, { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, "gpt-5.6-sol"))
      .toBeUndefined();
    expect(claudeTurnCostUsd(catalog, null, "claude-opus-5-5")).toBeUndefined();
  });

  it("prices a DeepSeek-compatible Claude endpoint with DeepSeek rates", () => {
    const usage = {
      input_tokens: 15,
      cache_read_input_tokens: 150,
      output_tokens: 53,
    };

    // (15 non-cache input * 0.3 + 150 cached * 0.006 + 53 output * 1.2) / 1M
    expect(claudeTurnCostUsd(catalog, usage, "deepseek-v4.1-flash")).toBe(0.000069);
    expect(claudeTurnCostUsd(catalog, usage, "opencode/deepseek-v4.1-flash-free")).toBe(0.000069);
    expect(claudeTurnCostUsd(catalog, usage, "deepseek-v4.1-flash-1017")).toBe(0.000069);
    expect(claudeTurnCostUsd(catalog, usage, "gemini-3.8-flash")).toBeUndefined();
  });

  it("prices Antigravity usage with thinking tokens as output", () => {
    const usage = {
      input_tokens: 165,
      cached_input_tokens: 150,
      output_tokens: 30,
      reasoning_output_tokens: 23,
    };

    // (15 non-cache input * 0.75 + 150 cached * 0.075 + 53 output * 3.75) / 1M
    expect(antigravityTurnCostUsd(catalog, usage, "gemini-3.8-flash")).toBe(0.000221);
    // (15 * 2 + 150 * 0.1 + 53 * 10) / 1M
    expect(antigravityTurnCostUsd(catalog, usage, "gemini-4-argon")).toBe(0.000575);
    expect(antigravityTurnCostUsd(catalog, usage, "gemini-unknown")).toBeUndefined();
    expect(antigravityTurnCostUsd(catalog, null, "gemini-3.8-flash")).toBeUndefined();
  });
});

describe("fixed inference price reference", () => {
  const completeInput = {
    input_total: 1_000,
    cache_read: 100,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_write_unknown: 0,
    output_total: 1_000,
  };

  it.each([
    ["claude", "claude-fable-5-2", 0.04722],
    ["claude", "claude-fable-5-1", 0.059025],
    ["codex", "gpt-6-astra", 0.0591],
    ["antigravity", "gemini-4-carbon", 0.01181],
    ["antigravity", "gemini-4-argon", 0.01181],
    ["deepseek", "deepseek-flash", 0.0014706],
    ["deepseek", "deepseek-v4.1-flash", 0.0014706],
  ])("prices the fixed %s reference row", (provider, model, expectedCost) => {
    const result = priceInferenceUsage(catalog, { provider, model, ...completeInput });

    expect(result.known_cost_usd).toBe(expectedCost);
    expect(result.price_version).toBe("api-list-usd-2026-10-19-v1");
    expect(result.as_of).toBe("2026-10-19");
    expect(result.priced_tokens).toBe(2_000);
    expect(result.unpriced_tokens).toBe(0);
    expect(result.pricing_complete).toBe(true);
  });

  it("uses exact aliases and leaves Kimi and fuzzy names unknown", () => {
    const alias = priceInferenceUsage(catalog, {
      provider: "deepseek",
      model: "opencode/deepseek-v4.1-flash-free",
      ...completeInput,
    });
    const kimi = priceInferenceUsage(catalog, {
      provider: "kimi",
      model: "kimi-for-coding",
      ...completeInput,
    });
    const fuzzy = priceInferenceUsage(catalog, {
      provider: "deepseek",
      model: "vendor/deepseek-flash",
      ...completeInput,
    });

    expect(alias.known_cost_usd).toBe(0.0014706);
    expect(alias.pricing_complete).toBe(true);
    expect(kimi.known_cost_usd).toBeNull();
    expect(kimi.priced_tokens).toBe(0);
    expect(kimi.unpriced_tokens).toBe(2_000);
    expect(kimi.pricing_complete).toBe(false);
    expect(fuzzy.known_cost_usd).toBeNull();
  });

  it("prices cache hits once as an input subset", () => {
    const result = priceInferenceUsage(catalog, {
      provider: "codex",
      model: "gpt-6-sol",
      input_total: 10_000,
      cache_read: 10_000,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 0,
    });

    expect(result.known_cost_usd).toBe(0.002);
    expect(result.priced_tokens).toBe(10_000);
    expect(result.unpriced_tokens).toBe(0);
    expect(result.pricing_complete).toBe(true);
  });

  it("returns a known subtotal and counts unknown cache TTL tokens once", () => {
    const result = priceInferenceUsage(catalog, {
      provider: "claude",
      model: "claude-opus-5-5",
      input_total: 1_000,
      cache_read: 100,
      cache_write_5m: 100,
      cache_write_1h: 0,
      cache_write_unknown: 800,
      output_total: 100,
    });

    expect(result.known_cost_usd).toBe(0.00252);
    expect(result.priced_tokens).toBe(300);
    expect(result.unpriced_tokens).toBe(800);
    expect(result.pricing_complete).toBe(false);
    expect(result.unpriced_reasons).toContain("cache_write_ttl_unknown");
  });

  it("does not infer base input when cache volume is unknown", () => {
    const result = priceInferenceUsage(catalog, {
      provider: "claude",
      model: "claude-opus-5-5",
      input_total: 1_000,
      cache_read: null,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 100,
    });

    expect(result.known_cost_usd).toBe(0.002);
    expect(result.priced_tokens).toBe(100);
    expect(result.unpriced_tokens).toBe(1_000);
    expect(result.pricing_complete).toBe(false);
    expect(result.unpriced_reasons).toContain("input_components_unknown");
  });

  it("distinguishes known zero cost from unknown pricing and usage", () => {
    const zero = priceInferenceUsage(catalog, {
      provider: "claude",
      model: "claude-opus-5-5",
      input_total: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 0,
    });
    const unknown = priceInferenceUsage(catalog, {
      provider: "claude",
      model: "kimi-for-coding",
      input_total: null,
      cache_read: null,
      cache_write_5m: null,
      cache_write_1h: null,
      cache_write_unknown: null,
      output_total: null,
    });

    expect(zero.known_cost_usd).toBe(0);
    expect(zero.pricing_complete).toBe(true);
    expect(unknown.known_cost_usd).toBeNull();
    expect(unknown.unpriced_tokens).toBeNull();
    expect(unknown.pricing_complete).toBe(false);
  });
});

describe("precise inference price components", () => {
  it("splits a complete gpt-6.1-sol vector into exact read and non-cache decimals", () => {
    const input = {
      provider: "codex",
      model: "gpt-6.1-sol",
      input_total: 100,
      cache_read: 60,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 20,
    };
    const components = priceInferenceUsageComponents(catalog, input);

    expect(components.price_version).toBe("api-list-usd-2026-10-19-v1");
    expect(components.cache_read).toEqual({ known_cost_usd_decimal: "0.000006", is_partial: false });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0.00028", is_partial: false });
    expect(priceInferenceUsage(catalog, input).known_cost_usd).toBe(0.000286);
  });

  it("keeps the non-cache side partial for unknown-TTL cache writes without touching read", () => {
    const input = {
      provider: "codex",
      model: "gpt-6.1-sol",
      input_total: 100,
      cache_read: 60,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 10,
      output_total: 20,
    };
    const components = priceInferenceUsageComponents(catalog, input);

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: "0.000006", is_partial: false });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0.00026", is_partial: true });
    expect(priceInferenceUsage(catalog, input).known_cost_usd).toBe(0.000266);
  });

  it("leaves read unknown while pricing the known output remainder", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "codex",
      model: "gpt-6.1-sol",
      input_total: 100,
      cache_read: null,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 20,
    });

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: null, is_partial: true });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0.0002", is_partial: true });
  });

  it("keeps read complete when the input total is unknown", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "codex",
      model: "gpt-6.1-sol",
      input_total: null,
      cache_read: 60,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 20,
    });

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: "0.000006", is_partial: false });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0.0002", is_partial: true });
  });

  it("returns both sides unknown for an unpriced model", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "codex",
      model: "gpt-5.6-sol",
      input_total: 100,
      cache_read: 60,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 20,
    });

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: null, is_partial: true });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: null, is_partial: true });
  });

  it("distinguishes a confirmed zero component from a missing one", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "claude",
      model: "claude-opus-5-5",
      input_total: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 0,
    });

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: "0", is_partial: false });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0", is_partial: false });
  });

  it("prices 5-minute and 1-hour cache writes into the non-cache side", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "claude",
      model: "claude-opus-5-5",
      input_total: 2_000,
      cache_read: 0,
      cache_write_5m: 1_000,
      cache_write_1h: 1_000,
      cache_write_unknown: 0,
      output_total: 0,
    });

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: "0", is_partial: false });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0.013", is_partial: false });
  });

  it("marks a known write amount with an unknown rate as an unpriced non-cache part", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "deepseek",
      model: "opencode/deepseek-v4.1-flash-free",
      input_total: 1_000,
      cache_read: 100,
      cache_write_5m: 50,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 100,
    });

    expect(components.cache_read).toEqual({ known_cost_usd_decimal: "0.0000006", is_partial: false });
    expect(components.non_cache).toEqual({ known_cost_usd_decimal: "0.000375", is_partial: true });
  });
});
