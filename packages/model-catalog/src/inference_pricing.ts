const CLAUDE_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing?tab=suite";
const GOOGLE_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
const DEEPSEEK_PRICING_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";

type ModelRates = {
  input: number;
  cacheRead: number;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  output: number;
};

// Existing rows retain their earlier values unless the snapshot metadata names them as refreshed.
export const LIST_PRICES = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.125, output: 0.5 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 10 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 10 },
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 12.5, output: 50 },
} as const;

export const PRICE_SNAPSHOT_METADATA = {
  price_version: "api-list-usd-2026-10-19-v1",
  as_of: "2026-10-19",
  checked_at: "2026-10-19",
  currency: "USD",
  unit: "per_1m_tokens",
  model_mapping_version: "exact-provider-model-v1",
  legacy_rows_last_checked_at: "2026-10-05",
  refreshed_model_rows: {
    claude: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"],
    codex: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
    antigravity: ["gemini-4-argon", "gemini-3.8-flash"],
    deepseek: [
      "deepseek-v4.1-flash-1017",
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "opencode/deepseek-v4.1-flash-free",
    ],
  },
  sources: {
    claude: CLAUDE_PRICING_SOURCE,
    codex: OPENAI_PRICING_SOURCE,
    antigravity: GOOGLE_PRICING_SOURCE,
    deepseek: DEEPSEEK_PRICING_SOURCE,
  },
  assumptions: [
    "Standard API prices and default context tiers are used for the fixed snapshot.",
    "DeepSeek V4.1 Flash uses the 1017 peak schedule; the OpenCode free-harness alias is priced at API list price, not at $0.",
    "Gemini promotional rates remain frozen in this snapshot after their published end dates.",
    "Other legacy rows retain their previous 2026-10-05 values and are not claimed as reverified for this snapshot.",
  ],
} as const;

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
  price_version: typeof PRICE_SNAPSHOT_METADATA.price_version;
  source: string | null;
  as_of: typeof PRICE_SNAPSHOT_METADATA.as_of;
  known_cost_usd: number | null;
  priced_tokens: number;
  unpriced_tokens: number | null;
  pricing_complete: boolean;
  unpriced_reasons: string[];
};

export type PriceInferenceUsageComponentsResult = {
  price_version: typeof PRICE_SNAPSHOT_METADATA.price_version;
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
  rates: ModelRates;
  source: string;
};

const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude:claude-opus-5-5": { rates: LIST_PRICES["claude-opus-5-5"], source: CLAUDE_PRICING_SOURCE },
  "claude:claude-fable-5-1": { rates: LIST_PRICES["claude-fable-5-1"], source: CLAUDE_PRICING_SOURCE },
  "claude:claude-opus-5": { rates: LIST_PRICES["claude-opus-5"], source: CLAUDE_PRICING_SOURCE },
  "claude:claude-sonnet-5-5": { rates: LIST_PRICES["claude-sonnet-5-5"], source: CLAUDE_PRICING_SOURCE },
  "claude:claude-sonnet-5": { rates: LIST_PRICES["claude-sonnet-5"], source: CLAUDE_PRICING_SOURCE },
  "claude:claude-opus-4-8": { rates: LIST_PRICES["claude-opus-4-8"], source: CLAUDE_PRICING_SOURCE },
  "claude:claude-haiku-4-5": { rates: LIST_PRICES["claude-haiku-4-5"], source: CLAUDE_PRICING_SOURCE },
  "codex:gpt-6-luna": { rates: LIST_PRICES["gpt-6-luna"], source: OPENAI_PRICING_SOURCE },
  "codex:gpt-6-sol": { rates: LIST_PRICES["gpt-6-sol"], source: OPENAI_PRICING_SOURCE },
  "codex:gpt-6.1-sol": { rates: LIST_PRICES["gpt-6.1-sol"], source: OPENAI_PRICING_SOURCE },
  "codex:gpt-6-astra": { rates: LIST_PRICES["gpt-6-astra"], source: OPENAI_PRICING_SOURCE },
  "antigravity:gemini-4-argon": {
    rates: { input: 2, cacheRead: 0.1, cacheWrite5m: null, cacheWrite1h: null, output: 10 },
    source: GOOGLE_PRICING_SOURCE,
  },
  "antigravity:gemini-3.8-flash": {
    rates: { input: 0.75, cacheRead: 0.075, cacheWrite5m: null, cacheWrite1h: null, output: 3.75 },
    source: GOOGLE_PRICING_SOURCE,
  },
  "deepseek:deepseek-flash": {
    rates: { input: 0.3, cacheRead: 0.006, cacheWrite5m: null, cacheWrite1h: null, output: 1.2 },
    source: DEEPSEEK_PRICING_SOURCE,
  },
};

const EXACT_MODEL_ALIASES: Record<string, string> = {
  "claude:claude-opus-5-5": "claude:claude-opus-5-5",
  "claude:claude-fable-5-1": "claude:claude-fable-5-1",
  "claude:claude-opus-5": "claude:claude-opus-5",
  "claude:claude-sonnet-5-5": "claude:claude-sonnet-5-5",
  "claude:claude-sonnet-5": "claude:claude-sonnet-5",
  "claude:claude-opus-4-8": "claude:claude-opus-4-8",
  "claude:claude-haiku-4-5": "claude:claude-haiku-4-5",
  "codex:gpt-6-luna": "codex:gpt-6-luna",
  "codex:gpt-6-sol": "codex:gpt-6-sol",
  "codex:gpt-6.1-sol": "codex:gpt-6.1-sol",
  "codex:gpt-6-astra": "codex:gpt-6-astra",
  "antigravity:gemini-4-argon": "antigravity:gemini-4-argon",
  "antigravity:gemini-3.8-flash": "antigravity:gemini-3.8-flash",
  "deepseek:deepseek-flash": "deepseek:deepseek-flash",
  "deepseek:deepseek-v4.1-flash-1017": "deepseek:deepseek-flash",
  "deepseek:deepseek-v4-flash": "deepseek:deepseek-flash",
  "deepseek:deepseek-v4-flash-vision-exp": "deepseek:deepseek-flash",
  "deepseek:opencode/deepseek-v4.1-flash-free": "deepseek:deepseek-flash",
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
  input: PriceInferenceUsageInput,
  reason: string,
): PriceInferenceUsageResult {
  return {
    price_version: PRICE_SNAPSHOT_METADATA.price_version,
    source: null,
    as_of: PRICE_SNAPSHOT_METADATA.as_of,
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
 * priceInferenceUsage(input: PriceInferenceUsageInput): PriceInferenceUsageResult
 * Amounts are normalized, input_total includes its cache subsets, and rates use the fixed USD/1M snapshot.
 */
function resolveModelPrice(input: PriceInferenceUsageInput): ModelPrice | undefined {
  if (input.model === null) return undefined;
  const modelKey = `${input.provider}:${normalizePricedModelId(input.model)}`;
  const canonicalKey = EXACT_MODEL_ALIASES[modelKey];
  return canonicalKey === undefined ? undefined : MODEL_PRICES[canonicalKey];
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
    priceComponent("read", cacheRead, modelPrice.rates.cacheRead, "cache_read_price_unknown");
  }

  if (cacheWrite5m === null) {
    reasons.add("cache_write_5m_unknown");
    nonCachePartial = true;
  } else {
    priceComponent("non_cache", cacheWrite5m, modelPrice.rates.cacheWrite5m, "cache_write_price_unknown");
  }

  if (cacheWrite1h === null) {
    reasons.add("cache_write_1h_unknown");
    nonCachePartial = true;
  } else {
    priceComponent("non_cache", cacheWrite1h, modelPrice.rates.cacheWrite1h, "cache_write_price_unknown");
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
  input: PriceInferenceUsageInput,
): PriceInferenceUsageResult {
  const modelPrice = resolveModelPrice(input);
  if (modelPrice === undefined) return unpricedResult(input, "model_price_unknown");

  const parts = computePricedComponentParts(input, modelPrice);
  const costNumerator = parts.readNumerator + parts.nonCacheNumerator;

  return {
    price_version: PRICE_SNAPSHOT_METADATA.price_version,
    source: modelPrice.source,
    as_of: PRICE_SNAPSHOT_METADATA.as_of,
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
 * priceInferenceUsageComponents(input: PriceInferenceUsageInput): PriceInferenceUsageComponentsResult
 * Splits the fixed-snapshot cost into cache-read and non-cache parts as exact decimal USD strings.
 * Cache-read covers cache_read; non-cache covers ordinary input, timed cache writes, and output.
 */
export function priceInferenceUsageComponents(
  input: PriceInferenceUsageInput,
): PriceInferenceUsageComponentsResult {
  const modelPrice = resolveModelPrice(input);
  if (modelPrice === undefined) {
    return {
      price_version: PRICE_SNAPSHOT_METADATA.price_version,
      cache_read: { known_cost_usd_decimal: null, is_partial: true },
      non_cache: { known_cost_usd_decimal: null, is_partial: true },
    };
  }

  const parts = computePricedComponentParts(input, modelPrice);
  return {
    price_version: PRICE_SNAPSHOT_METADATA.price_version,
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
