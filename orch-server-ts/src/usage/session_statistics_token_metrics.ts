export type SourceTokenInput = {
  input_total: number | null;
  output_total: number | null;
  cache_read: number | null;
  cache_write: number | null;
};

export type SourceTokenMetrics = {
  provider_total_tokens: number | null;
  total_tokens: number | null;
  ordinary_input: number | null;
};

function safeAdd(...values: number[]): number | null {
  let total = 0;
  for (const value of values) total += value;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Per-source cache-separated token metrics.
 *
 * `total_tokens` is the new public total (ordinary input + cache write + output)
 * which excludes cache reads. `provider_total_tokens` is the provider-inclusive
 * total (input + output) kept for conversion-ratio denominators. Derived values
 * are produced only when every operand is known and the cache subsets stay
 * within the inclusive input total; otherwise they are null.
 */
export function sourceTokenMetrics(input: SourceTokenInput): SourceTokenMetrics {
  const { input_total, output_total, cache_read, cache_write } = input;
  const providerTotal = input_total !== null && output_total !== null
    ? safeAdd(input_total, output_total)
    : null;

  let total: number | null = null;
  if (input_total !== null && cache_read !== null && output_total !== null
    && cache_read <= input_total && (cache_write === null || cache_read + cache_write <= input_total)) {
    total = safeAdd(input_total, -cache_read, output_total);
  }

  let ordinary: number | null = null;
  if (input_total !== null && cache_read !== null && cache_write !== null
    && cache_read + cache_write <= input_total) {
    ordinary = safeAdd(input_total, -cache_read, -cache_write);
  }

  return { provider_total_tokens: providerTotal, total_tokens: total, ordinary_input: ordinary };
}

export function sumKnownTokenMetrics(values: Iterable<number | null>): number | null {
  let total = 0;
  let found = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    found = true;
  }
  return found ? safeAdd(total) : null;
}
