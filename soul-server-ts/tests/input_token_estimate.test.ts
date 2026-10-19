import { describe, expect, it } from "vitest";

import { estimateInputTokens } from "@soulstream/model-catalog/input-token-estimate";

describe("input token estimates", () => {
  it("prefers a stored numeric estimate, including zero", () => {
    expect(estimateInputTokens({ storedTokenEstimate: 0, charsUtf16: 8 })).toBe(0);
    expect(estimateInputTokens({ storedTokenEstimate: 12, charsUtf16: 1 })).toBe(12);
  });

  it("rounds each visible source up before summing", () => {
    const estimates = [{ charsUtf16: 1 }, { charsUtf16: 1 }]
      .map((input) => estimateInputTokens(input))
      .reduce<number>((sum, estimate) => sum + (estimate ?? 0), 0);

    expect(estimates).toBe(2);
  });

  it("returns null when neither estimate is available", () => {
    expect(estimateInputTokens({})).toBeNull();
    expect(estimateInputTokens({ storedTokenEstimate: null, charsUtf16: null })).toBeNull();
  });

  it("preserves previously stored aggregate estimates", () => {
    expect(estimateInputTokens({ storedTokenEstimate: 218_000 })).toBe(218_000);
    expect(estimateInputTokens({ storedTokenEstimate: 283_000 })).toBe(283_000);
  });
});
