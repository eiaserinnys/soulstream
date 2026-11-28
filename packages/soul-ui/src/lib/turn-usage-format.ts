import { intlLocale, type Language } from "@soulstream/i18n";
import { asRecord } from "../../../wire-schema/src/json_record";

export const TURN_COMPLETE_LABEL = "턴 완료";
export const TURN_USAGE_SEPARATOR = " · ";

const decimalOptions = { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false };

export function formatTurnCompleteStats(input: {
  usage?: unknown;
  turnCostUsd?: unknown;
  sessionCostUsd?: unknown;
  sessionCostPartial?: unknown;
}, language: Language = "ko"): string | undefined {
  const locale = intlLocale(language);
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
        ? ` (캐시 ${cacheTokens.toLocaleString(locale)})`
        : "";
      parts.push(`입력 ${totalInputTokens.toLocaleString(locale)}${cacheSuffix}`);
      parts.push(`출력 ${outputTokens.toLocaleString(locale)}`);
    }
  }

  const turnCostUsd = asFiniteNumber(input.turnCostUsd);
  if (turnCostUsd !== undefined) {
    const sessionCostUsd = asFiniteNumber(input.sessionCostUsd);
    const sessionCost = sessionCostUsd === undefined
      ? ""
      : ` (세션 ${formatPrice(sessionCostUsd, locale)}${input.sessionCostPartial === true ? "+" : ""})`;
    parts.push(`정가 ${formatPrice(turnCostUsd, locale)}${sessionCost}`);
  }

  return parts.length > 0 ? parts.join(TURN_USAGE_SEPARATOR) : undefined;
}

export function formatContextUsageText(input: {
  usedTokens?: unknown;
  maxTokens?: unknown;
  percent?: unknown;
  estimated?: unknown;
}, language: Language = "ko"): string | undefined {
  const usedTokens = asFiniteNumber(input.usedTokens);
  const maxTokens = asFiniteNumber(input.maxTokens);
  if (usedTokens === undefined || maxTokens === undefined) return undefined;

  const locale = intlLocale(language);
  const qualifier = input.estimated === true ? "약 " : "";
  const usage = `컨텍스트 ${qualifier}${usedTokens.toLocaleString(locale)} / ${maxTokens.toLocaleString(locale)}`;
  const percent = asFiniteNumber(input.percent);
  return percent === undefined ? usage : `${usage} (${percent.toLocaleString(locale, decimalOptions)}%)`;
}

export function formatTurnUsageCaptionTitle(input: {
  percent?: unknown;
  estimated?: unknown;
  usage?: unknown;
  turnCostUsd?: unknown;
}, language: Language = "ko"): string | undefined {
  const locale = intlLocale(language);
  const parts: string[] = [];
  const percent = asFiniteNumber(input.percent);
  if (percent !== undefined) {
    const qualifier = input.estimated === true ? "약 " : "";
    parts.push(`컨텍스트 ${qualifier}${percent.toLocaleString(locale, decimalOptions)}%`);
  }

  const turnCostUsd = asFiniteNumber(input.turnCostUsd);
  if (turnCostUsd !== undefined) {
    parts.push(`정가 ${formatPrice(turnCostUsd, locale)}`);
  }

  if (parts.length > 0) return parts.join(TURN_USAGE_SEPARATOR);
  return formatTurnCompleteStats({ usage: input.usage }, language);
}

function formatPrice(value: number, locale: string): string {
  const fixed = value.toFixed(2);
  if (value > 0 && fixed === "0.00") return "<$0.01";

  const decimalIndex = fixed.indexOf(".");
  const whole = fixed.slice(0, decimalIndex);
  const fraction = fixed.slice(decimalIndex + 1);
  return `$${Number(whole).toLocaleString(locale)}.${fraction}`;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
