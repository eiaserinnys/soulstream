import { describe, expect, it } from "vitest";
import type { ModelCatalogConfig } from "@soulstream/model-catalog";
import {
  aggregateSubagentRollups,
  computeSessionSubagentRollups,
  type TurnSubagentUsageTurn,
} from "../src/control_plane/repositories/turn_usage_subagents.js";

const DEEPSEEK_RATES = {
  input: 0.3,
  cache_read: 0.006,
  cache_write_5m: null,
  cache_write_1h: null,
  output: 1.2,
};
const CLAUDE_RATES = {
  input: 5,
  cache_read: 0.5,
  cache_write_5m: 6.25,
  cache_write_1h: 10,
  output: 25,
};

function catalogWith(models: ModelCatalogConfig["models"]): ModelCatalogConfig {
  return {
    schema_version: 1,
    groups: [],
    presets: [],
    models,
    price_snapshot: {
      price_version: "test-v1",
      as_of: "2026-10-19",
      checked_at: "2026-10-19",
      currency: "USD",
      unit: "per_1m_tokens",
      model_mapping_version: "test-v1",
      refreshed_model_rows: {},
      sources: {},
      assumptions: [],
    },
    persistent_defaults: { model_preset: "claude-opus", fallback_models: [] },
    task_defaults: {
      turn_summary: { model_preset: "claude-opus" },
      turn_story: { model_preset: "claude-opus" },
      instruction_extraction: { model_preset: "claude-opus" },
    },
    provider_model_prefixes: [],
  };
}

const DEEPSEEK_CATALOG = catalogWith([
  { provider: "deepseek", model: "deepseek-flash", aliases: ["deepseek-v4.1-flash"], rates: DEEPSEEK_RATES },
]);

function turn(overrides: Partial<TurnSubagentUsageTurn> & { event_id: number }): TurnSubagentUsageTurn {
  return {
    model: "claude-opus-5-5",
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    model_usage: undefined,
    ...overrides,
  };
}

describe("computeSessionSubagentRollups", () => {
  it("diffs cumulative model_usage per turn, merges canonical models, and subtracts the main session bucket", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 10,
        model: "claude-opus-5-5",
        input_tokens: 1000,
        cached_input_tokens: 200,
        cache_write_tokens: 100,
        output_tokens: 100,
        cost_usd: 1.0,
        model_usage: {
          "claude-opus-5-5[1m]": {
            inputTokens: 2000,
            cacheReadInputTokens: 400,
            cacheCreationInputTokens: 100,
            outputTokens: 160,
            costUSD: 1.5,
            canonicalModel: "claude-opus-5-5",
          },
          "claude-sonnet-5-5": {
            inputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 40,
            costUSD: 0.25,
          },
        },
      }),
      turn({
        event_id: 12,
        model: "claude-opus-5-5",
        input_tokens: 300,
        cached_input_tokens: 50,
        output_tokens: 50,
        cost_usd: 0.25,
        model_usage: {
          "claude-opus-5-5[1m]": {
            inputTokens: 2400,
            cacheReadInputTokens: 450,
            cacheCreationInputTokens: 100,
            outputTokens: 190,
            costUSD: 1.75,
            canonicalModel: "claude-opus-5-5",
          },
          "claude-sonnet-5-5": {
            inputTokens: 800,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 60,
            costUSD: 0.5,
          },
          "claude-haiku-5-5": {
            inputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 10,
            costUSD: 0.125,
          },
        },
      }),
    ]);

    expect(rollups.get(10)).toEqual({
      subagent_input_tokens: 2000,
      subagent_cached_input_tokens: 200,
      subagent_cache_write_tokens: 0,
      subagent_output_tokens: 100,
      subagent_cost_usd: 0.75,
      subagent_models: [
        {
          model: "claude-opus-5-5",
          input_tokens: 1500,
          cached_input_tokens: 200,
          cache_write_tokens: 0,
          output_tokens: 60,
          cost_usd: 0.5,
        },
        {
          model: "claude-sonnet-5-5",
          input_tokens: 500,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 40,
          cost_usd: 0.25,
        },
      ],
    });
    expect(rollups.get(12)).toEqual({
      subagent_input_tokens: 550,
      subagent_cached_input_tokens: 0,
      subagent_cache_write_tokens: 0,
      subagent_output_tokens: 30,
      subagent_cost_usd: 0.375,
      subagent_models: [
        {
          model: "claude-sonnet-5-5",
          input_tokens: 300,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 20,
          cost_usd: 0.25,
        },
        {
          model: "claude-haiku-5-5",
          input_tokens: 100,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 10,
          cost_usd: 0.125,
        },
        {
          model: "claude-opus-5-5",
          input_tokens: 150,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
        },
      ],
    });
  });

  it("uses the anchor turn before the period as the diff base instead of counting its cumulative total again", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 5,
        model: "claude-opus-5-5",
        input_tokens: 1000,
        cached_input_tokens: 100,
        output_tokens: 100,
        cost_usd: 0.9,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 1000,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 0,
            outputTokens: 100,
            costUSD: 1.0,
          },
        },
      }),
      turn({
        event_id: 10,
        model: "claude-opus-5-5",
        input_tokens: 400,
        cached_input_tokens: 50,
        output_tokens: 40,
        cost_usd: 0.125,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 1600,
            cacheReadInputTokens: 150,
            cacheCreationInputTokens: 0,
            outputTokens: 150,
            costUSD: 1.25,
          },
        },
      }),
    ]);

    expect(rollups.get(10)).toEqual({
      subagent_input_tokens: 250,
      subagent_cached_input_tokens: 0,
      subagent_cache_write_tokens: 0,
      subagent_output_tokens: 10,
      subagent_cost_usd: 0.125,
      subagent_models: [
        {
          model: "claude-opus-5-5",
          input_tokens: 250,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 10,
          cost_usd: 0.125,
        },
      ],
    });
  });

  it("treats a decreasing cumulative usage as a CLI restart and diffs from zero", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 2,
        model: "claude-opus-5-5",
        input_tokens: 800,
        output_tokens: 90,
        cost_usd: 0.9,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 800,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 100,
            costUSD: 1.0,
          },
        },
      }),
      turn({
        event_id: 4,
        model: "claude-opus-5-5",
        input_tokens: 250,
        output_tokens: 15,
        cost_usd: 0.25,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 20,
            costUSD: 0.3,
          },
        },
      }),
    ]);

    expect(rollups.get(2)).toMatchObject({
      subagent_input_tokens: 0,
      subagent_output_tokens: 10,
      subagent_cost_usd: 0.1,
    });
    expect(rollups.get(4)).toMatchObject({
      subagent_input_tokens: 50,
      subagent_output_tokens: 5,
      subagent_cost_usd: 0.05,
    });
  });

  it("keeps the previous cumulative base when a turn has no valid model_usage", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 1,
        input_tokens: 100,
        output_tokens: 10,
        cost_usd: 0.1,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 200,
            outputTokens: 20,
            costUSD: 0.2,
          },
        },
      }),
      turn({ event_id: 2, model_usage: null }),
      turn({
        event_id: 3,
        input_tokens: 100,
        output_tokens: 10,
        cost_usd: 0.1,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 400,
            outputTokens: 40,
            costUSD: 0.4,
          },
        },
      }),
    ]);

    expect(rollups.get(1)).toMatchObject({ subagent_input_tokens: 100, subagent_output_tokens: 10 });
    expect(rollups.has(2)).toBe(false);
    expect(rollups.get(3)).toMatchObject({ subagent_input_tokens: 100, subagent_output_tokens: 10 });
  });

  it("skips a turn without a main model and keeps the failed turn out of the next diff", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 1,
        input_tokens: 100,
        output_tokens: 10,
        cost_usd: 0.1,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 200,
            outputTokens: 20,
            costUSD: 0.2,
          },
        },
      }),
      turn({
        event_id: 2,
        model: null,
        input_tokens: 50,
        output_tokens: 5,
        cost_usd: 0.05,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 260,
            outputTokens: 26,
            costUSD: 0.26,
          },
        },
      }),
      turn({
        event_id: 3,
        input_tokens: 100,
        output_tokens: 10,
        cost_usd: 0.1,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 400,
            outputTokens: 40,
            costUSD: 0.4,
          },
        },
      }),
    ]);

    expect(rollups.get(1)).toMatchObject({
      subagent_input_tokens: 100,
      subagent_output_tokens: 10,
      subagent_cost_usd: 0.1,
    });
    expect(rollups.has(2)).toBe(false);
    expect(rollups.get(3)).toMatchObject({
      subagent_input_tokens: 40,
      subagent_output_tokens: 4,
      subagent_cost_usd: 0.04,
    });
  });

  it("skips a turn whose main model is missing from the cumulative snapshot when the turn used tokens", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 1,
        model: "claude-sonnet-5-5",
        input_tokens: 100,
        output_tokens: 10,
        model_usage: {
          "claude-opus-5-5": {
            inputTokens: 300,
            outputTokens: 30,
          },
        },
      }),
    ]);

    expect(rollups.size).toBe(0);
  });

  it("returns no rollup when no turn carries a usable model_usage object", () => {
    const rollups = computeSessionSubagentRollups([
      turn({ event_id: 1 }),
      turn({ event_id: 2, model_usage: "not-an-object" }),
      turn({ event_id: 3, model_usage: [1, 2, 3] }),
    ]);

    expect(rollups.size).toBe(0);
  });

  it("drops a zero-token bucket whose only residue is the CLI's Claude-rate pricing of a non-Claude main turn", () => {
    const rollups = computeSessionSubagentRollups(
      [
        turn({
          event_id: 1,
          model: "deepseek-v4.1-flash",
          input_tokens: 1_000_000,
          output_tokens: 50_000,
          cost_usd: 0.8,
          model_usage: {
            "deepseek-v4.1-flash": {
              inputTokens: 1_000_000,
              outputTokens: 50_000,
              costUSD: 50,
            },
          },
        }),
      ],
      DEEPSEEK_CATALOG,
    );

    expect(rollups.size).toBe(0);
  });

  it("reprices a non-Claude subagent bucket from the repository catalogue instead of the CLI cost residue", () => {
    const rollups = computeSessionSubagentRollups([
      turn({
        event_id: 1,
        model: "deepseek-v4.1-flash",
        input_tokens: 1_000_000,
        output_tokens: 50_000,
        cost_usd: 0.35,
        model_usage: {
          "deepseek-v4.1-flash": {
            inputTokens: 2_000_000,
            outputTokens: 100_000,
            costUSD: 50,
          },
        },
      }),
    ]);

    expect(rollups.get(1)).toEqual({
      subagent_input_tokens: 1_000_000,
      subagent_cached_input_tokens: 0,
      subagent_cache_write_tokens: 0,
      subagent_output_tokens: 50_000,
      subagent_cost_usd: 0.36,
      subagent_models: [
        {
          model: "deepseek-v4.1-flash",
          input_tokens: 1_000_000,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 50_000,
          cost_usd: 0.36,
        },
      ],
    });
  });

  it("keeps tokens but omits cost for a non-Claude model the catalogue lists without rates", () => {
    const catalog = catalogWith([
      { provider: "claude", model: "claude-opus-5-5", aliases: [], rates: CLAUDE_RATES },
      { provider: "kimi", model: "kimi-for-coding/k3", aliases: [], rates: null },
    ]);

    const rollups = computeSessionSubagentRollups(
      [
        turn({
          event_id: 1,
          model: "claude-opus-5-5",
          input_tokens: 500,
          output_tokens: 50,
          cost_usd: 0.5,
          model_usage: {
            "claude-opus-5-5": { inputTokens: 500, outputTokens: 50, costUSD: 0.5 },
            "kimi-for-coding/k3": { inputTokens: 10_000, outputTokens: 1_000, costUSD: 5 },
          },
        }),
      ],
      catalog,
    );

    expect(rollups.get(1)).toEqual({
      subagent_input_tokens: 10_000,
      subagent_cached_input_tokens: 0,
      subagent_cache_write_tokens: 0,
      subagent_output_tokens: 1_000,
      subagent_models: [
        {
          model: "kimi-for-coding/k3",
          input_tokens: 10_000,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 1_000,
        },
      ],
    });
  });

  it("keeps the CLI cost for a bucket whose model the catalogue does not know", () => {
    const catalog = catalogWith([
      { provider: "claude", model: "claude-opus-5-5", aliases: [], rates: CLAUDE_RATES },
    ]);

    const rollups = computeSessionSubagentRollups(
      [
        turn({
          event_id: 1,
          model: "claude-opus-5-5",
          input_tokens: 500,
          output_tokens: 50,
          cost_usd: 0.5,
          model_usage: {
            "claude-opus-5-5": { inputTokens: 500, outputTokens: 50, costUSD: 0.5 },
            "qwen3.8-27b": { inputTokens: 10_000, outputTokens: 1_000, costUSD: 5 },
          },
        }),
      ],
      catalog,
    );

    expect(rollups.get(1)).toMatchObject({
      subagent_input_tokens: 10_000,
      subagent_output_tokens: 1_000,
      subagent_cost_usd: 5,
    });
  });
});

describe("aggregateSubagentRollups", () => {
  it("merges per-turn rollups into one session rollup", () => {
    const merged = aggregateSubagentRollups([
      {
        subagent_input_tokens: 100,
        subagent_cached_input_tokens: 20,
        subagent_cache_write_tokens: 0,
        subagent_output_tokens: 10,
        subagent_cost_usd: 0.125,
        subagent_models: [
          { model: "claude-opus-5-5", input_tokens: 100, cached_input_tokens: 20, cache_write_tokens: 0, output_tokens: 10, cost_usd: 0.125 },
        ],
      },
      {
        subagent_input_tokens: 300,
        subagent_cached_input_tokens: 0,
        subagent_cache_write_tokens: 5,
        subagent_output_tokens: 30,
        subagent_cost_usd: 0.25,
        subagent_models: [
          { model: "claude-opus-5-5", input_tokens: 200, cached_input_tokens: 0, cache_write_tokens: 5, output_tokens: 20, cost_usd: 0.125 },
          { model: "claude-sonnet-5-5", input_tokens: 100, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 10, cost_usd: 0.125 },
        ],
      },
    ]);

    expect(merged).toEqual({
      subagent_input_tokens: 400,
      subagent_cached_input_tokens: 20,
      subagent_cache_write_tokens: 5,
      subagent_output_tokens: 40,
      subagent_cost_usd: 0.375,
      subagent_models: [
        { model: "claude-opus-5-5", input_tokens: 300, cached_input_tokens: 20, cache_write_tokens: 5, output_tokens: 30, cost_usd: 0.25 },
        { model: "claude-sonnet-5-5", input_tokens: 100, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 10, cost_usd: 0.125 },
      ],
    });
  });

  it("returns undefined for an empty iterable", () => {
    expect(aggregateSubagentRollups([])).toBeUndefined();
  });
});
