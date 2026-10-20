import type { UsageStatsTokenPartials } from "@soulstream/wire-schema/session-statistics";
import { sourceTokenMetrics, type SourceTokenInput } from "./session_statistics_token_metrics.js";

const ALL_UNKNOWN: UsageStatsTokenPartials = {
  total_tokens: true,
  provider_total_tokens: true,
  ordinary_input: true,
  cache_read: true,
};

/**
 * Fold selected source token fields and real missing/factless evidence into the
 * per-field partial flags exposed on coverage. Collection-only unknowns and
 * pending inputs do not set these flags by themselves; they arrive here as
 * `missingAllFields` only when actual terminal or ended evidence has no usage
 * fields at all.
 */
export function foldTokenPartials(
  sources: readonly SourceTokenInput[],
  missingAllFields: boolean,
): UsageStatsTokenPartials {
  if (missingAllFields) return ALL_UNKNOWN;
  if (sources.length === 0) return ALL_UNKNOWN;
  let totalUnknown = false;
  let providerUnknown = false;
  let ordinaryUnknown = false;
  let cacheReadUnknown = false;
  for (const source of sources) {
    const metrics = sourceTokenMetrics(source);
    if (metrics.total_tokens === null) totalUnknown = true;
    if (metrics.provider_total_tokens === null) providerUnknown = true;
    if (metrics.ordinary_input === null) ordinaryUnknown = true;
    if (source.cache_read === null) cacheReadUnknown = true;
  }
  return {
    total_tokens: totalUnknown,
    provider_total_tokens: providerUnknown,
    ordinary_input: ordinaryUnknown,
    cache_read: cacheReadUnknown,
  };
}
