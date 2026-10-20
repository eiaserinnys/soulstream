import {
  PRICE_SNAPSHOT_METADATA,
  priceInferenceUsageComponents,
} from "@soulstream/model-catalog/inference-pricing";
import type { FactDraft } from "./session_statistics_fact_types.js";
import {
  compareDecimal,
  parseDecimal,
  subtractDecimal,
  type Decimal,
} from "./session_statistics_decimal.js";
import { sourceTokenMetrics } from "./session_statistics_token_metrics.js";

export type SourceCostSplit = {
  cacheRead: Decimal | null;
  nonCache: Decimal | null;
  cacheReadPartial: boolean;
  nonCachePartial: boolean;
};

const ZERO = parseDecimal("0");

function unsplit(): SourceCostSplit {
  return { cacheRead: null, nonCache: null, cacheReadPartial: true, nonCachePartial: true };
}

/**
 * Split one selected source's stored canonical cost (`read.costDecimals`) into
 * cache-read and non-cache components using the shared pricing component helper.
 *
 * The stored NUMERIC decimal is the only total source; the helper is used for
 * exact component values, never to re-price the total. When the cost cannot be
 * explained by the known priced components the split stays null and partial
 * while the stored total is preserved by the caller.
 */
export function splitSourceCost(fact: FactDraft, storedCostDecimal: string | null): SourceCostSplit | null {
  if (storedCostDecimal === null) return null;
  const tokens = sourceTokenMetrics(fact);
  const cacheReadPartial = fact.cache_read === null;
  const nonCachePartial = tokens.ordinary_input === null || tokens.total_tokens === null;
  if (fact.pricing_version === null || fact.pricing_version !== PRICE_SNAPSHOT_METADATA.price_version) {
    return unsplit();
  }

  const components = priceInferenceUsageComponents({
    provider: fact.provider,
    model: fact.model,
    input_total: fact.input_total,
    cache_read: fact.cache_read,
    cache_write_5m: fact.cache_write !== null ? 0 : null,
    cache_write_1h: fact.cache_write !== null ? 0 : null,
    cache_write_unknown: fact.cache_write,
    output_total: fact.output_total,
  });
  const cacheReadValue = components.cache_read.known_cost_usd_decimal;
  const nonCacheValue = components.non_cache.known_cost_usd_decimal;
  const readFlag = components.cache_read.is_partial || cacheReadPartial;
  const writeFlag = components.non_cache.is_partial || nonCachePartial;

  if (cacheReadValue === null && nonCacheValue === null) return unsplit();

  const stored = parseDecimal(storedCostDecimal);
  if (cacheReadValue !== null) {
    const cacheRead = parseDecimal(cacheReadValue);
    if (compareDecimal(cacheRead, ZERO) < 0 || compareDecimal(cacheRead, stored) > 0) return unsplit();
    if (nonCacheValue !== null) {
      const nonCache = subtractDecimal(stored, cacheRead);
      return { cacheRead, nonCache, cacheReadPartial: readFlag, nonCachePartial: writeFlag };
    }
    if (compareDecimal(stored, cacheRead) !== 0) return unsplit();
    return { cacheRead, nonCache: null, cacheReadPartial: readFlag, nonCachePartial: true };
  }

  return { cacheRead: null, nonCache: stored, cacheReadPartial: true, nonCachePartial: writeFlag };
}
