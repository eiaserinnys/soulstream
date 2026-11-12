import type { ModelCatalogConfig, ModelCatalogModel, ModelCatalogRates } from "./index.js";

export type PriceInferenceUsageInput = {
  provider: string;
  model: string | null;
  input_total: number | null;
  cache_read: number | null;
  cache_write_5m: number | null;
  cache_write_1h: number | null;
  cache_write_unknown: number | null;
  output_total: number | null;
};

export type PriceInferenceUsageResult = {
  price_version: string;
  source: string | null;
  as_of: string;
  known_cost_usd: number | null;
  priced_tokens: number;
  unpriced_tokens: number | null;
  pricing_complete: boolean;
  unpriced_reasons: string[];
};

export type PriceInferenceUsageComponentsResult = {
  price_version: string;
  cache_read: {
    known_cost_usd_decimal: string | null;
    is_partial: boolean;
  };
  non_cache: {
    known_cost_usd_decimal: string | null;
    is_partial: boolean;
  };
};

type ModelPrice = {
  rates: ModelCatalogRates;
  source: string | null;
};

const RATE_SCALE = 1_000_000n;
const USD_DENOMINATOR = 1_000_000_000_000n;

function usdPerMillionToScaledRate(rate: number): bigint {
  return BigInt(Math.round(rate * Number(RATE_SCALE)));
}

function numeratorToDecimalString(numerator: bigint): string {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const whole = absolute / USD_DENOMINATOR;
  const fraction = (absolute % USD_DENOMINATOR)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

export function normalizePricedModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

function unpricedTokenCount(input: PriceInferenceUsageInput, pricedTokens: number): number | null {
  if (input.input_total === null || input.output_total === null) return null;
  return input.input_total + input.output_total - pricedTokens;
}

function unpricedResult(
  catalog: ModelCatalogConfig,
  input: PriceInferenceUsageInput,
  reason: string,
): PriceInferenceUsageResult {
  return {
    price_version: catalog.price_snapshot.price_version,
    source: null,
    as_of: catalog.price_snapshot.as_of,
    known_cost_usd: null,
    priced_tokens: 0,
    unpriced_tokens: input.input_total === null || input.output_total === null
      ? null
      : input.input_total + input.output_total,
    pricing_complete: false,
    unpriced_reasons: [reason],
  };
}

/**
 * Published signature:
 * priceInferenceUsage(catalog, input: PriceInferenceUsageInput): PriceInferenceUsageResult
 * Amounts are normalized, input_total includes its cache subsets, and rates come
 * from the catalogue's fixed USD/1M snapshot. The row is looked up only under the
 * input's own provider.
 */
function findModelRowForProvider(
  catalog: ModelCatalogConfig,
  provider: string,
  model: string,
): ModelCatalogModel | undefined {
  const match = (candidate: string): ModelCatalogModel | undefined => catalog.models.find(
    (row) => row.provider === provider
      && (row.model === candidate || row.aliases.includes(candidate)),
  );
  const exact = match(model);
  if (exact !== undefined) return exact;
  const normalized = normalizePricedModelId(model);
  return normalized === model ? undefined : match(normalized);
}

function resolveModelPrice(
  catalog: ModelCatalogConfig,
  input: PriceInferenceUsageInput,
): ModelPrice | undefined {
  if (input.model === null) return undefined;
  const row = findModelRowForProvider(catalog, input.provider, input.model);
  if (row === undefined || row.rates === null) return undefined;
  return { rates: row.rates, source: row.source ?? null };
}

type PriceBucket = "read" | "non_cache";

type PricedComponentParts = {
  readNumerator: bigint;
  nonCacheNumerator: bigint;
  readPriced: boolean;
  nonCachePriced: boolean;
  readPartial: boolean;
  nonCachePartial: boolean;
  pricedTokens: number;
  pricedComponents: number;
  reasons: Set<string>;
};

function computePricedComponentParts(
  input: PriceInferenceUsageInput,
  modelPrice: ModelPrice,
): PricedComponentParts {
  let readNumerator = 0n;
  let nonCacheNumerator = 0n;
  let pricedTokens = 0;
  let pricedComponents = 0;
  let readPriced = false;
  let nonCachePriced = false;
  let readPartial = false;
  let nonCachePartial = false;
  const reasons = new Set<string>();
  const priceComponent = (
    bucket: PriceBucket,
    amount: number,
    rate: number | null,
    missingPriceReason: string,
  ) => {
    if (rate === null) {
      if (amount > 0) {
        reasons.add(missingPriceReason);
        if (bucket === "read") readPartial = true;
        else nonCachePartial = true;
      }
      return;
    }
    const numerator = BigInt(amount) * usdPerMillionToScaledRate(rate);
    if (bucket === "read") {
      readNumerator += numerator;
      readPriced = true;
    } else {
      nonCacheNumerator += numerator;
      nonCachePriced = true;
    }
    pricedTokens += amount;
    pricedComponents += 1;
  };

  const cacheRead = input.cache_read;
  const cacheWrite5m = input.cache_write_5m;
  const cacheWrite1h = input.cache_write_1h;
  const cacheWriteUnknown = input.cache_write_unknown;
  const cacheAmounts = [cacheRead, cacheWrite5m, cacheWrite1h, cacheWriteUnknown];
  const inputComponentsKnown = cacheAmounts.every((amount) => amount !== null);

  if (input.input_total === null) {
    reasons.add("input_total_unknown");
    nonCachePartial = true;
  } else if (!inputComponentsKnown) {
    reasons.add("input_components_unknown");
    nonCachePartial = true;
  } else {
    const cacheTokens = cacheAmounts.reduce((sum, amount) => sum + (amount ?? 0), 0);
    const inputBase = input.input_total - cacheTokens;
    priceComponent("non_cache", inputBase, modelPrice.rates.input, "input_price_unknown");
  }

  if (cacheRead === null) {
    reasons.add("cache_read_unknown");
    readPartial = true;
  } else {
    priceComponent("read", cacheRead, modelPrice.rates.cache_read, "cache_read_price_unknown");
  }

  if (cacheWrite5m === null) {
    reasons.add("cache_write_5m_unknown");
    nonCachePartial = true;
  } else {
    priceComponent("non_cache", cacheWrite5m, modelPrice.rates.cache_write_5m, "cache_write_price_unknown");
  }

  if (cacheWrite1h === null) {
    reasons.add("cache_write_1h_unknown");
    nonCachePartial = true;
  } else {
    priceComponent("non_cache", cacheWrite1h, modelPrice.rates.cache_write_1h, "cache_write_price_unknown");
  }

  if (cacheWriteUnknown === null) {
    reasons.add("cache_write_amount_unknown");
    nonCachePartial = true;
  } else if (cacheWriteUnknown > 0) {
    reasons.add("cache_write_ttl_unknown");
    nonCachePartial = true;
  }

  if (input.output_total === null) {
    reasons.add("output_total_unknown");
    nonCachePartial = true;
  } else {
    priceComponent("non_cache", input.output_total, modelPrice.rates.output, "output_price_unknown");
  }

  return {
    readNumerator,
    nonCacheNumerator,
    readPriced,
    nonCachePriced,
    readPartial,
    nonCachePartial,
    pricedTokens,
    pricedComponents,
    reasons,
  };
}

export function priceInferenceUsage(
  catalog: ModelCatalogConfig,
  input: PriceInferenceUsageInput,
): PriceInferenceUsageResult {
  const modelPrice = resolveModelPrice(catalog, input);
  if (modelPrice === undefined) return unpricedResult(catalog, input, "model_price_unknown");

  const parts = computePricedComponentParts(input, modelPrice);
  const costNumerator = parts.readNumerator + parts.nonCacheNumerator;

  return {
    price_version: catalog.price_snapshot.price_version,
    source: modelPrice.source,
    as_of: catalog.price_snapshot.as_of,
    known_cost_usd: parts.pricedComponents === 0
      ? null
      : Number(costNumerator) / Number(USD_DENOMINATOR),
    priced_tokens: parts.pricedTokens,
    unpriced_tokens: unpricedTokenCount(input, parts.pricedTokens),
    pricing_complete: parts.reasons.size === 0,
    unpriced_reasons: [...parts.reasons],
  };
}

/**
 * Published signature:
 * priceInferenceUsageComponents(catalog, input: PriceInferenceUsageInput): PriceInferenceUsageComponentsResult
 * Splits the fixed-snapshot cost into cache-read and non-cache parts as exact decimal USD strings.
 * Cache-read covers cache_read; non-cache covers ordinary input, timed cache writes, and output.
 */
export function priceInferenceUsageComponents(
  catalog: ModelCatalogConfig,
  input: PriceInferenceUsageInput,
): PriceInferenceUsageComponentsResult {
  const modelPrice = resolveModelPrice(catalog, input);
  if (modelPrice === undefined) {
    return {
      price_version: catalog.price_snapshot.price_version,
      cache_read: { known_cost_usd_decimal: null, is_partial: true },
      non_cache: { known_cost_usd_decimal: null, is_partial: true },
    };
  }

  const parts = computePricedComponentParts(input, modelPrice);
  return {
    price_version: catalog.price_snapshot.price_version,
    cache_read: {
      known_cost_usd_decimal: parts.readPriced
        ? numeratorToDecimalString(parts.readNumerator)
        : null,
      is_partial: parts.readPartial,
    },
    non_cache: {
      known_cost_usd_decimal: parts.nonCachePriced
        ? numeratorToDecimalString(parts.nonCacheNumerator)
        : null,
      is_partial: parts.nonCachePartial,
    },
  };
}
