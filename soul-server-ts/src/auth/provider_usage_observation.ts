import type { ProviderUsageName, ProviderLimits } from "./provider_usage.js";

export type DecisionProvider = Extract<ProviderUsageName, "claude" | "codex">;

export interface ProviderUsageObservation {
  result: ProviderLimits;
  observed_at: string | null;
}

const observations = new Map<DecisionProvider, ProviderUsageObservation>();

export function rememberProviderUsageObservation(
  provider: DecisionProvider,
  result: ProviderLimits,
  observedAt = new Date().toISOString(),
): void {
  observations.set(provider, {
    result,
    observed_at: observedAt,
  });
}

export function readProviderUsageObservation(
  provider: DecisionProvider,
): ProviderUsageObservation | undefined {
  return observations.get(provider);
}

export function resetProviderUsageObservationMemo(): void {
  observations.clear();
}
