import { describe, expect, it } from "vitest";
import { generationCostThresholds } from "../../src/task/persistent_generation_cost.js";
import { firstCallCacheEstimate } from "../../src/task/persistent_decision_config.js";

const profile = {
  baselineTokens: 130418, initEquivalentInputTokens: 233769.25,
  growthTokensPerCall: 9446 / 3, readMultiplier: 0.05,
  source: "seed", sampleCount: 1, priceVersion: "test",
};

describe("generation cost thresholds", () => {
  it("uses the initialization cost, restored context and cache miss", () => {
    expect(generationCostThresholds(profile, null, 1000000, 80000)).toEqual({
      warmTokens: 302007, arrivalTokens: 162548, cacheEstimate: "unknown",
    });
    expect(generationCostThresholds(profile, 1, 1000000, 80000)).toMatchObject({
      warmTokens: 302007, arrivalTokens: 302007, cacheEstimate: "measured",
    });
    const partial = generationCostThresholds(profile, 0.5, 1000000, 80000);
    expect(partial.arrivalTokens).toBeGreaterThan(162548);
    expect(partial.arrivalTokens).toBeLessThan(302007);
  });

  it("handles zero growth and the context capacity", () => {
    expect(generationCostThresholds({ ...profile, growthTokensPerCall: 0 }, null, 1000000, 80000))
      .toMatchObject({ warmTokens: 920000, arrivalTokens: Math.ceil(233769.25 / 0.95) });
    expect(generationCostThresholds(profile, 1, 200000, 80000))
      .toMatchObject({ warmTokens: 120000, arrivalTokens: 120000 });
  });
  it("uses observed token-weighted cache fractions at idle bin boundaries", () => {
    expect(firstCallCacheEstimate("gemini-4-hydrogen", 239.999)).toMatchObject({ fraction: 341836 / 441173, sampleCount: 4 });
    expect(firstCallCacheEstimate("gemini-4-hydrogen", 240)).toMatchObject({ fraction: null, sampleCount: 0 });
    expect(firstCallCacheEstimate("gemini-4-argon", 299.999)).toMatchObject({ fraction: 68117 / 1984754, sampleCount: 11 });
    expect(firstCallCacheEstimate("gemini-4-argon", 300)).toMatchObject({ fraction: 1018136 / 5053005, sampleCount: 29 });
  });
});
