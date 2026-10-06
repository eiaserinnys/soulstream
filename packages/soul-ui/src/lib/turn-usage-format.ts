// soul-app directly imports this source file, so keep it free of imports.
// Avoid destructuring, spread, and other syntax that can inject Babel runtime helpers.
export const TURN_COMPLETE_LABEL = "턴 완료";
export const TURN_USAGE_SEPARATOR = " · ";

type UnknownRecord = Record<string, unknown>;

export function formatTurnCompleteStats(input: {
  usage?: unknown;
  turnCostUsd?: unknown;
  sessionCostUsd?: unknown;
  sessionCostPartial?: unknown;
}): string | undefined {
  const parts: string[] = [];
  const usage = asRecord(input.usage);
  if (usage) {
    const inputTokens = asFiniteNumber(usage.input_tokens);
    const outputTokens = asFiniteNumber(usage.output_tokens);
    if (inputTokens !== undefined && outputTokens !== undefined) {
      const claudeCacheTokens =
        (asFiniteNumber(usage.cache_read_input_tokens) ?? 0)
        + (asFiniteNumber(usage.cache_creation_input_tokens) ?? 0);
      const codexCachedTokens = asFiniteNumber(usage.cached_input_tokens) ?? 0;
      const cacheTokens = claudeCacheTokens || codexCachedTokens || 0;
      const totalInputTokens = inputTokens + claudeCacheTokens;
      const cacheSuffix = cacheTokens > 0
        ? ` (캐시 ${cacheTokens.toLocaleString("en-US")})`
        : "";
      parts.push(`입력 ${totalInputTokens.toLocaleString("en-US")}${cacheSuffix}`);
      parts.push(`출력 ${outputTokens.toLocaleString("en-US")}`);
    }
  }

  const turnCostUsd = asFiniteNumber(input.turnCostUsd);
  if (turnCostUsd !== undefined) {
    const sessionCostUsd = asFiniteNumber(input.sessionCostUsd);
    const sessionCost = sessionCostUsd === undefined
      ? ""
      : ` (세션 ${formatPrice(sessionCostUsd)}${input.sessionCostPartial === true ? "+" : ""})`;
    parts.push(`정가 ${formatPrice(turnCostUsd)}${sessionCost}`);
  }

  return parts.length > 0 ? parts.join(TURN_USAGE_SEPARATOR) : undefined;
}

export function formatContextUsageText(input: {
  usedTokens?: unknown;
  maxTokens?: unknown;
  percent?: unknown;
  estimated?: unknown;
}): string | undefined {
  const usedTokens = asFiniteNumber(input.usedTokens);
  const maxTokens = asFiniteNumber(input.maxTokens);
  if (usedTokens === undefined || maxTokens === undefined) return undefined;

  const qualifier = input.estimated === true ? "약 " : "";
  const usage = `컨텍스트 ${qualifier}${usedTokens.toLocaleString("en-US")} / ${maxTokens.toLocaleString("en-US")}`;
  const percent = asFiniteNumber(input.percent);
  return percent === undefined ? usage : `${usage} (${percent.toFixed(1)}%)`;
}

export function formatTurnUsageCaptionTitle(input: {
  percent?: unknown;
  estimated?: unknown;
  usage?: unknown;
  turnCostUsd?: unknown;
}): string | undefined {
  const parts: string[] = [];
  const percent = asFiniteNumber(input.percent);
  if (percent !== undefined) {
    const qualifier = input.estimated === true ? "약 " : "";
    parts.push(`컨텍스트 ${qualifier}${percent.toFixed(1)}%`);
  }

  const turnCostUsd = asFiniteNumber(input.turnCostUsd);
  if (turnCostUsd !== undefined) {
    parts.push(`정가 ${formatPrice(turnCostUsd)}`);
  }

  if (parts.length > 0) return parts.join(TURN_USAGE_SEPARATOR);
  return formatTurnCompleteStats({ usage: input.usage });
}

function formatPrice(value: number): string {
  const rounded = value.toFixed(2);
  if (value > 0 && rounded === "0.00") return "<$0.01";

  const decimalIndex = rounded.indexOf(".");
  const whole = rounded.slice(0, decimalIndex);
  const fraction = rounded.slice(decimalIndex + 1);
  return `$${Number(whole).toLocaleString("en-US")}.${fraction}`;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
