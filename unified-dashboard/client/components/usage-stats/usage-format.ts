import { isUsageStatsCostPartial } from "@seosoyoung/soul-ui";
import type { AdminTranslate } from "../config/admin-translation";
import type { UsageStatsAggregate, UsageStatsPeriod } from "../../../../packages/wire-schema/src/session_statistics";

type Metrics = UsageStatsAggregate["metrics"];
type Coverage = UsageStatsAggregate["coverage"];

export function usageDate(date: string, locale: string | undefined, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

export function usagePeriod(period: UsageStatsPeriod, since: string, until: string, locale: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = period === "week"
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short" };
  const start = new Date(`${since}T00:00:00Z`);
  const end = new Date(new Date(`${until}T00:00:00Z`).getTime() - 86_400_000);
  if (period === "week" && start.getUTCFullYear() !== end.getUTCFullYear()) options.year = "numeric";
  const format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  return period === "month" ? format.format(start) : format.formatRange(start, end);
}

export function usageNumber(value: number, metric: "tokens" | "cost", locale: string | undefined): string {
  return new Intl.NumberFormat(locale, metric === "tokens"
    ? { notation: "compact", maximumFractionDigits: 1 }
    : { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(value);
}

export function usageValue(
  metrics: Metrics, coverage: Coverage, metric: "tokens" | "cost", row: boolean,
  includeCacheRead: boolean, t: AdminTranslate, locale: string | undefined,
): string {
  if (metric === "tokens") {
    const value = includeCacheRead ? metrics.provider_total_tokens : metrics.total_tokens;
    const partial = includeCacheRead ? coverage.token_partials.provider_total_tokens : coverage.token_partials.total_tokens;
    return value === null || (value === 0 && partial)
      ? t("admin.stats.missingUsage")
      : `${usageNumber(value, metric, locale)}${partial ? "+" : ""}`;
  }
  if (row && metrics.provider_total_tokens === null) return t("admin.stats.missingUsage");
  const { known_cost_usd: value, is_partial: partial } = includeCacheRead
    ? { known_cost_usd: metrics.reference_cost_usd, is_partial: isUsageStatsCostPartial(coverage) }
    : metrics.reference_cost_breakdown.non_cache;
  return value === null || (value === 0 && partial)
    ? t(row ? "admin.stats.unknownPrice" : "admin.stats.unknownCost")
    : `${usageNumber(value, metric, locale)}${partial ? "+" : ""}`;
}

export function usageCacheSplit(metrics: Metrics | null | undefined, coverage: Coverage | null | undefined, t: AdminTranslate, locale: string | undefined) {
  if (!metrics || !coverage) return {
    cacheReadLine: t("admin.stats.cacheReadExcludedRule"),
    cacheReadCostLine: t("admin.stats.cacheReadIncludedRule"),
  };
  const tokens = metrics.cache_read;
  const partial = coverage.token_partials.cache_read;
  const cost = metrics.reference_cost_breakdown.cache_read;
  return {
    cacheReadLine: tokens === null || (tokens === 0 && partial)
      ? t("admin.stats.cacheReadMissing")
      : t("admin.stats.cacheReadTokens", { value: `${usageNumber(tokens, "tokens", locale)}${partial ? "+" : ""}` }),
    cacheReadCostLine: cost.known_cost_usd === null || (cost.known_cost_usd === 0 && cost.is_partial)
      ? t("admin.stats.cacheReadUnknownCost")
      : t("admin.stats.cacheReadCost", { value: `${usageNumber(cost.known_cost_usd, "cost", locale)}${cost.is_partial ? "+" : ""}` }),
  };
}

export function usageCoverage(priced: number | null, observed: number | null, partial: boolean, t: AdminTranslate, locale: string | undefined): string {
  if (!observed || observed <= 0) return "";
  if (partial || priced === null || priced < 0 || priced > observed) return t("admin.stats.partialCoverage");
  return t("admin.stats.pricedCoverage", { percent: new Intl.NumberFormat(locale, { style: "percent" }).format(priced / observed) });
}

export function approximateTokens(value: number | null, observed: boolean, partial: boolean, t: AdminTranslate, locale: string | undefined): string {
  if (value === null) return t(observed ? "admin.stats.unobserved" : "admin.stats.missingUsage");
  if (partial && value === 0) return t("admin.stats.missingUsage");
  return t(observed ? "admin.stats.estimated" : "admin.stats.approximate", { value: `${value.toLocaleString(locale)}${partial ? "+" : ""}` });
}
