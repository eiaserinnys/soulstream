/** Costs are expressed in the price of one uncached input token. */
export interface GenerationCostProfile {
  baselineTokens: number;
  initEquivalentInputTokens: number;
  growthTokensPerCall: number;
  readMultiplier: number;
  source: string;
  sampleCount: number;
  priceVersion: string;
}

export function generationCostThresholds(
  profile: GenerationCostProfile,
  expectedFirstCallCacheFraction: number | null,
  maxContextTokens: number,
  reserveTokens: number,
): { warmTokens: number; arrivalTokens: number; cacheEstimate: "measured" | "unknown" } {
  const { baselineTokens: b, initEquivalentInputTokens: a, growthTokensPerCall: g, readMultiplier: r } = profile;
  const q = (1 - r) * (1 - (expectedFirstCallCacheFraction ?? 0));
  const cap = maxContextTokens - reserveTokens;
  const warm = g === 0 ? Infinity : b + Math.sqrt(2 * a * g / r);
  const kappa = 2 * g * q / r;
  const arrival = g === 0
    ? q === 0 ? Infinity : a / q
    : 2 * warm * warm / (2 * warm + kappa + Math.sqrt(kappa * kappa + 4 * kappa * warm));
  return {
    warmTokens: Math.ceil(Math.min(warm, cap)),
    arrivalTokens: Math.ceil(Math.min(arrival, cap)),
    cacheEstimate: expectedFirstCallCacheFraction === null ? "unknown" : "measured",
  };
}
