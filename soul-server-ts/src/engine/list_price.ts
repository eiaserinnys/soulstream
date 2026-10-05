// Public list prices checked 2026-10-05.
// Claude: https://platform.claude.com/docs/en/about-claude/pricing
// OpenAI: https://developers.openai.com/api/docs/pricing?tab=suite
// Model pages: https://developers.openai.com/api/docs/models/gpt-6-luna
// gpt-6-sol: https://developers.openai.com/api/docs/models/compare?model=gpt-6-sol
// gpt-6.1-sol and gpt-6-astra values are also recorded in
// .local/artifacts/cache-billing-261005/report.md.

export const LIST_PRICES = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.125, output: 0.5 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 10 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 2.5, output: 10 },
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 12.5, output: 50 },
} as const;

type PricedModelId = keyof typeof LIST_PRICES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function priceFor(model: string | null | undefined) {
  if (model == null) return undefined;
  const normalized = normalizePricedModelId(model);
  return Object.hasOwn(LIST_PRICES, normalized)
    ? LIST_PRICES[normalized as PricedModelId]
    : undefined;
}

export function normalizePricedModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

export function claudeTurnCostUsd(usage: unknown, model: string | null | undefined): number | undefined {
  const price = priceFor(model);
  if (!price || !isRecord(usage)) return undefined;

  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;

  const cacheRead = finiteNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreated = finiteNumber(usage.cache_creation_input_tokens) ?? 0;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const cacheWrite5m = finiteNumber(cacheCreation?.ephemeral_5m_input_tokens) ?? 0;
  const cacheWrite1h = cacheCreated - cacheWrite5m;
  const microdollars =
    input * price.input +
    cacheRead * price.cacheRead +
    cacheWrite5m * price.cacheWrite5m +
    cacheWrite1h * price.cacheWrite1h +
    output * price.output;
  return Math.round(microdollars) / 1_000_000;
}

export function codexTurnCostUsd(
  usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number },
  model: string | null | undefined,
): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;

  const input = finiteNumber(usage.input_tokens);
  const cached = finiteNumber(usage.cached_input_tokens);
  const output = finiteNumber(usage.output_tokens);
  if (input === undefined || cached === undefined || output === undefined) return undefined;

  const microdollars =
    (input - cached) * price.input +
    cached * price.cacheRead +
    output * price.output;
  return Math.round(microdollars) / 1_000_000;
}
