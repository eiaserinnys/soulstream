import {
  LIST_PRICES,
  normalizePricedModelId,
  priceInferenceUsage,
} from "@soulstream/model-catalog/inference-pricing";

export { LIST_PRICES, normalizePricedModelId, priceInferenceUsage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function legacyCostUsd(result: ReturnType<typeof priceInferenceUsage>): number | undefined {
  if (!result.pricing_complete || result.known_cost_usd === null) return undefined;
  return Math.round(result.known_cost_usd * 1_000_000) / 1_000_000;
}

export function claudeTurnCostUsd(usage: unknown, model: string | null | undefined): number | undefined {
  if (!isRecord(usage)) return undefined;

  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;

  const cacheRead = finiteNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreatedTotal = finiteNumber(usage.cache_creation_input_tokens);
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const cacheWrite5m = finiteNumber(cacheCreation?.ephemeral_5m_input_tokens) ?? 0;
  const cacheWrite1h = finiteNumber(cacheCreation?.ephemeral_1h_input_tokens) ?? 0;
  const cacheWriteTotal = cacheCreatedTotal ?? cacheWrite5m + cacheWrite1h;
  const cacheWriteUnknown = cacheWriteTotal - cacheWrite5m - cacheWrite1h;

  const normalizedModel = typeof model === "string" ? model.trim().toLowerCase() : undefined;
  if (
    normalizedModel !== undefined
    && (normalizedModel.startsWith("deepseek-")
      || normalizedModel.startsWith("opencode/deepseek-"))
  ) {
    // Claude Code can drive a DeepSeek-compatible endpoint; its usage arrives in
    // Anthropic shape but must be priced with DeepSeek rates.
    const deepseekResult = priceInferenceUsage({
      provider: "deepseek",
      model: model ?? null,
      input_total: input + cacheRead + cacheWriteTotal,
      cache_read: cacheRead,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: output,
    });
    return legacyCostUsd(deepseekResult);
  }

  const result = priceInferenceUsage({
    provider: "claude",
    model: model ?? null,
    input_total: input + cacheRead + cacheWriteTotal,
    cache_read: cacheRead,
    cache_write_5m: cacheWrite5m,
    cache_write_1h: cacheWrite1h,
    cache_write_unknown: cacheWriteUnknown,
    output_total: output,
  });
  return legacyCostUsd(result);
}

/**
 * Antigravity usage is reported in the whole-conversation shape the engine emits:
 * `input_tokens` already includes cache reads and `reasoning_output_tokens` holds
 * thinking tokens, which Gemini prices as output.
 */
export function antigravityTurnCostUsd(usage: unknown, model: unknown): number | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTotal = nonNegativeNumber(usage.input_tokens) ?? 0;
  const cachedInput = nonNegativeNumber(usage.cached_input_tokens) ?? 0;
  const outputTotal = (nonNegativeNumber(usage.output_tokens) ?? 0)
    + (nonNegativeNumber(usage.reasoning_output_tokens) ?? 0);
  const result = priceInferenceUsage({
    provider: "antigravity",
    model: typeof model === "string" ? model : null,
    input_total: inputTotal,
    cache_read: cachedInput,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_write_unknown: 0,
    output_total: outputTotal,
  });
  return legacyCostUsd(result);
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

export function codexTurnCostUsd(
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number },
  model: string | null | undefined,
): number | undefined {
  const input = finiteNumber(usage.input_tokens);
  const cached = finiteNumber(usage.cached_input_tokens);
  const output = finiteNumber(usage.output_tokens);
  if (input === undefined || cached === undefined || output === undefined) return undefined;

  const result = priceInferenceUsage({
    provider: "codex",
    model: model ?? null,
    input_total: input,
    cache_read: cached,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_write_unknown: 0,
    output_total: output,
  });
  return legacyCostUsd(result);
}
