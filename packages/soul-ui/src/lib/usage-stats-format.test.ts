import { describe, expect, it } from "vitest";
import type { UsageStatsMetrics } from "../../../wire-schema/src/session_statistics";

import {
  formatUsageStatsCacheSplit,
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsPeriodLabel,
  formatUsageStatsApproximateTokens,
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
  isUsageStatsTokenPartial,
  shiftUsageStatsAnchor,
  usageStatsBucketStarts,
  usageStatsCalendarRange,
  usageStatsKstDate,
  usageStatsMonthAnchor,
  usageStatsModelColorIndex,
  formatUsageStatsValue,
  USAGE_STATS_LABELS,
  usageStatsMetricValue,
  usageStatsRange,
} from "./usage-stats-format";

const EMPTY_TOKEN_PARTIALS = {
  total_tokens: false,
  provider_total_tokens: false,
  ordinary_input: false,
  cache_read: false,
};

const EMPTY_COVERAGE = {
  usage_partial_events: 0,
  missing_usage_turns: 0,
  unknown_total_token_events: 0,
  unpriced_events: 0,
  unattributed_missing_usage: false,
  token_partials: EMPTY_TOKEN_PARTIALS,
};

function coverageWith(tokenPartials: Partial<typeof EMPTY_TOKEN_PARTIALS> = {}) {
  return {
    ...EMPTY_COVERAGE,
    token_partials: { ...EMPTY_TOKEN_PARTIALS, ...tokenPartials },
  };
}

function splitMetrics(): UsageStatsMetrics {
  return {
    input_total: 100,
    cache_read: 60,
    cache_write: 0,
    output_total: 20,
    reasoning_output: 0,
    total_tokens: 60,
    provider_total_tokens: 120,
    ordinary_input: 40,
    reference_cost_usd: 3,
    reference_cost_breakdown: {
      cache_read: { known_cost_usd: 45, is_partial: false },
      non_cache: { known_cost_usd: 78.45, is_partial: false },
    },
  };
}

describe("usage statistics formatting", () => {
  it("shares month drilldown anchors, stable model ranks, and estimated input token units", () => {
    expect(usageStatsMonthAnchor("2026-10-01", "2026-10-19T00:00:00+09:00")).toBe("2026-10-19");
    expect(usageStatsMonthAnchor("2026-09-01", "2026-10-19T00:00:00+09:00")).toBe("2026-09-30");
    expect(usageStatsRange("week", usageStatsMonthAnchor("2026-09-01", "2026-10-19"), "2026-10-19", "2026-09-01")).toMatchObject({ since: "2026-09-28", until: "2026-10-05" });
    expect(usageStatsModelColorIndex("sonnet", ["opus", "sonnet"])).toBe(1);
    expect(usageStatsModelColorIndex(null, ["opus", "sonnet"])).toBe(-1);
    expect(formatUsageStatsApproximateTokens(283000, true)).toBe("추정 약 283,000 토큰");
    expect(formatUsageStatsApproximateTokens(283000)).toBe("약 283,000 토큰");
    expect(formatUsageStatsApproximateTokens(0, true)).toBe("추정 약 0 토큰");
    expect(formatUsageStatsApproximateTokens(null, true)).toBe("관측 안 됨");
    expect(formatUsageStatsApproximateTokens(8, false, true)).toBe("약 8+ 토큰");
    expect(formatUsageStatsApproximateTokens(0, false, true)).toBe("미기록");
    expect(formatUsageStatsCoverage(0, 0)).toBe("");
    expect(formatUsageStatsCoverage(null, null)).toBe("");
  });
  it("shares unknown price wording and never invents a zero partial total", () => {
    const coverage = coverageWith({ total_tokens: true });
    expect(formatUsageStatsValue({ total_tokens: null, provider_total_tokens: null, reference_cost_usd: null }, coverage, "cost")).toBe("미확인");
    expect(formatUsageStatsValue({ total_tokens: null, provider_total_tokens: null, reference_cost_usd: null }, coverage, "cost", true)).toBe("미기록");
    expect(formatUsageStatsValue({ total_tokens: 5, provider_total_tokens: 5, reference_cost_usd: null }, coverage, "cost", true)).toBe("정가 미확인");
    expect(formatUsageStatsValue({ total_tokens: 0, provider_total_tokens: 0, reference_cost_usd: 0 }, coverage, "tokens")).toBe("미기록");
  });
  it("does not mark positive totals partial for pending-only or unknown collection evidence", () => {
    const pendingOnly = {
      ...coverageWith(),
      pending_inputs: 1,
      collection_state: "unknown",
    };
    expect(formatUsageStatsValue({ total_tokens: 8, provider_total_tokens: 8, reference_cost_usd: null }, pendingOnly, "tokens")).toBe("8");
  });
  it("keeps measured zero distinct from missing data", () => {
    expect(formatUsageStatsTokenCount(0)).toBe("0");
    expect(formatUsageStatsTokenCount(null)).toBe("미기록");
    expect(formatUsageStatsUsd(0)).toBe("$0.00");
    expect(formatUsageStatsUsd(null)).toBe("미확인");
  });

  it("names the observed-token denominator in coverage", () => {
    expect(formatUsageStatsCoverage(8_200, 10_000)).toBe("기록 토큰 82% 환산");
    expect(formatUsageStatsCoverage(1, null)).toBe("");
    expect(formatUsageStatsCoverage(120, 120)).toBe("기록 토큰 100% 환산");
    expect(formatUsageStatsCoverage(60, 120)).toBe("기록 토큰 50% 환산");
    expect(formatUsageStatsCoverage(0, 120)).toBe("기록 토큰 0% 환산");
  });

  it("reports a partial denominator when pricing or the token breakdown is incomplete", () => {
    expect(formatUsageStatsCoverage(120, 120, true)).toBe("일부만 환산");
    expect(formatUsageStatsCoverage(121, 120)).toBe("일부만 환산");
    expect(formatUsageStatsCoverage(-1, 120)).toBe("일부만 환산");
    expect(formatUsageStatsCoverage(null, 120)).toBe("일부만 환산");
    expect(formatUsageStatsCoverage(1, 0)).toBe("");
    expect(formatUsageStatsCoverage(1, -1)).toBe("");
  });

  it("marks token totals partial from the token_partials canon, not raw evidence counts", () => {
    expect(isUsageStatsTokenPartial(coverageWith())).toBe(false);
    expect(isUsageStatsTokenPartial(coverageWith({ total_tokens: true }))).toBe(true);
    expect(isUsageStatsTokenPartial(coverageWith({ provider_total_tokens: true }))).toBe(false);
    expect(isUsageStatsTokenPartial(coverageWith({ ordinary_input: true }))).toBe(false);
    expect(isUsageStatsTokenPartial(coverageWith({ cache_read: true }))).toBe(false);
    const rawEvidence = {
      ...coverageWith(),
      usage_partial_events: 1,
      missing_usage_turns: 1,
      unknown_total_token_events: 1,
      unattributed_missing_usage: true,
    };
    expect(isUsageStatsTokenPartial(rawEvidence)).toBe(false);
  });

  it("formats the cache split with per-component and per-line partial marks", () => {
    expect(USAGE_STATS_LABELS).toMatchObject({
      nonCacheCost: "비캐시",
      cacheReadCost: "캐시 읽기",
      cacheReadExcludedRule: "캐시 읽기 제외",
      uncachedInput: "그중 일반 입력",
      cacheReadToggleGroup: "캐시 읽기",
      cacheReadExclude: "캐시 제외",
      cacheReadInclude: "캐시 포함",
    });
    expect(formatUsageStatsCacheSplit(null, null)).toEqual({
      cacheReadLine: "캐시 읽기 제외",
      nonCacheCost: "",
      cacheReadCost: "",
      ordinaryInput: "",
    });
    expect(formatUsageStatsCacheSplit(splitMetrics(), coverageWith())).toEqual({
      cacheReadLine: "캐시 읽기 60 제외",
      nonCacheCost: "$78.45",
      cacheReadCost: "$45.00",
      ordinaryInput: "40",
    });
    expect(formatUsageStatsCacheSplit(
      { ...splitMetrics(), ordinary_input: 1_000_000 },
      coverageWith(),
    ).ordinaryInput).toBe("1,000,000");
    const partialCosts = splitMetrics();
    partialCosts.reference_cost_breakdown = {
      cache_read: { known_cost_usd: 45, is_partial: true },
      non_cache: { known_cost_usd: 78.45, is_partial: true },
    };
    expect(formatUsageStatsCacheSplit(
      partialCosts,
      coverageWith({ cache_read: true, ordinary_input: true, provider_total_tokens: true }),
    )).toEqual({
      cacheReadLine: "캐시 읽기 60+ 제외",
      nonCacheCost: "$78.45+",
      cacheReadCost: "$45.00+",
      ordinaryInput: "40+",
    });
  });

  it("keeps missing, partial zero, and measured zero distinct in the cache split", () => {
    const missing = splitMetrics();
    missing.cache_read = null;
    missing.ordinary_input = null;
    missing.reference_cost_breakdown = {
      cache_read: { known_cost_usd: null, is_partial: true },
      non_cache: { known_cost_usd: null, is_partial: true },
    };
    expect(formatUsageStatsCacheSplit(missing, coverageWith({ cache_read: true, ordinary_input: true }))).toEqual({
      cacheReadLine: "캐시 읽기 미기록",
      nonCacheCost: "미확인",
      cacheReadCost: "미확인",
      ordinaryInput: "미기록",
    });

    const partialZero = splitMetrics();
    partialZero.cache_read = 0;
    partialZero.ordinary_input = 0;
    partialZero.reference_cost_breakdown = {
      cache_read: { known_cost_usd: 0, is_partial: true },
      non_cache: { known_cost_usd: 0, is_partial: true },
    };
    expect(formatUsageStatsCacheSplit(partialZero, coverageWith({ cache_read: true, ordinary_input: true }))).toEqual({
      cacheReadLine: "캐시 읽기 미기록",
      nonCacheCost: "미확인",
      cacheReadCost: "미확인",
      ordinaryInput: "미기록",
    });

    const measuredZero = splitMetrics();
    measuredZero.cache_read = 0;
    measuredZero.ordinary_input = 0;
    measuredZero.reference_cost_breakdown = {
      cache_read: { known_cost_usd: 0, is_partial: false },
      non_cache: { known_cost_usd: 0, is_partial: false },
    };
    expect(formatUsageStatsCacheSplit(measuredZero, coverageWith())).toEqual({
      cacheReadLine: "캐시 읽기 0 제외",
      nonCacheCost: "$0.00",
      cacheReadCost: "$0.00",
      ordinaryInput: "0",
    });
  });

  it("does not spread partial marks across independent cache lines", () => {
    const result = formatUsageStatsCacheSplit(
      splitMetrics(),
      coverageWith({ ordinary_input: true }),
    );
    expect(result.cacheReadLine).toBe("캐시 읽기 60 제외");
    expect(result.cacheReadCost).toBe("$45.00");
    expect(result.nonCacheCost).toBe("$78.45");
    expect(result.ordinaryInput).toBe("40+");

    const components = splitMetrics();
    components.reference_cost_breakdown = {
      cache_read: { known_cost_usd: 45, is_partial: true },
      non_cache: { known_cost_usd: 78.45, is_partial: false },
    };
    expect(formatUsageStatsCacheSplit(components, coverageWith()).cacheReadCost).toBe("$45.00+");
    expect(formatUsageStatsCacheSplit(components, coverageWith()).nonCacheCost).toBe("$78.45");
  });

  it("guards the cost row with provider_total_tokens instead of total_tokens", () => {
    expect(formatUsageStatsValue(
      { total_tokens: null, provider_total_tokens: 120, reference_cost_usd: 3 },
      coverageWith(),
      "cost",
      true,
    )).toBe("$3.00");
    expect(formatUsageStatsValue(
      { total_tokens: 120, provider_total_tokens: null, reference_cost_usd: null },
      coverageWith(),
      "cost",
      true,
    )).toBe("미기록");
  });

  it("selects cache-inclusive and cache-excluded metrics with independent partial states", () => {
    const metrics = { ...splitMetrics(), reference_cost_usd: 123.45 };
    const complete = coverageWith();

    expect(usageStatsMetricValue(metrics, "tokens", false)).toBe(60);
    expect(usageStatsMetricValue(metrics, "tokens", true)).toBe(120);
    expect(usageStatsMetricValue(metrics, "cost", false)).toBe(78.45);
    expect(usageStatsMetricValue(metrics, "cost", true)).toBe(123.45);
    expect(formatUsageStatsValue(metrics, complete, "tokens", false, false)).toBe("60");
    expect(formatUsageStatsValue(metrics, complete, "tokens", false, true)).toBe("120");
    expect(formatUsageStatsValue(metrics, complete, "cost", false, false)).toBe("$78.45");
    expect(formatUsageStatsValue(metrics, complete, "cost", false, true)).toBe("$123.45");
    expect(formatUsageStatsValue(metrics, complete, "cost")).toBe("$123.45");

    const partialCoverage = coverageWith({ total_tokens: true, provider_total_tokens: true });
    partialCoverage.unpriced_events = 1;
    const partialMetrics = { ...metrics };
    partialMetrics.reference_cost_breakdown = {
      ...metrics.reference_cost_breakdown,
      non_cache: { known_cost_usd: 78.45, is_partial: true },
    };
    expect(formatUsageStatsValue(partialMetrics, partialCoverage, "tokens", false, false)).toBe("60+");
    expect(formatUsageStatsValue(partialMetrics, partialCoverage, "tokens", false, true)).toBe("120+");
    expect(formatUsageStatsValue(partialMetrics, partialCoverage, "cost", false, false)).toBe("$78.45+");
    expect(formatUsageStatsValue(partialMetrics, partialCoverage, "cost", false, true)).toBe("$123.45+");

    const unknown = {
      ...metrics,
      total_tokens: null,
      provider_total_tokens: null,
      reference_cost_usd: null,
      reference_cost_breakdown: {
        cache_read: { known_cost_usd: null, is_partial: true },
        non_cache: { known_cost_usd: null, is_partial: true },
      },
    };
    expect(usageStatsMetricValue(unknown, "tokens", false)).toBeNull();
    expect(usageStatsMetricValue(unknown, "tokens", true)).toBeNull();
    expect(usageStatsMetricValue(unknown, "cost", false)).toBeNull();
    expect(usageStatsMetricValue(unknown, "cost", true)).toBeNull();
    expect(formatUsageStatsValue(unknown, complete, "tokens", false, false)).toBe("미기록");
    expect(formatUsageStatsValue(unknown, complete, "tokens", false, true)).toBe("미기록");
    expect(formatUsageStatsValue(unknown, complete, "cost", false, false)).toBe("미확인");
    expect(formatUsageStatsValue(unknown, complete, "cost", false, true)).toBe("미확인");

    const confirmedZero = {
      ...unknown,
      total_tokens: 0,
      provider_total_tokens: 0,
      reference_cost_usd: 0,
      reference_cost_breakdown: {
        cache_read: { known_cost_usd: 0, is_partial: false },
        non_cache: { known_cost_usd: 0, is_partial: false },
      },
    };
    expect(usageStatsMetricValue(confirmedZero, "tokens", false)).toBe(0);
    expect(usageStatsMetricValue(confirmedZero, "tokens", true)).toBe(0);
    expect(usageStatsMetricValue(confirmedZero, "cost", false)).toBe(0);
    expect(usageStatsMetricValue(confirmedZero, "cost", true)).toBe(0);
    expect(formatUsageStatsValue(confirmedZero, complete, "tokens", false, false)).toBe("0");
    expect(formatUsageStatsValue(confirmedZero, complete, "tokens", false, true)).toBe("0");
    expect(formatUsageStatsValue(confirmedZero, complete, "cost", false, false)).toBe("$0.00");
    expect(formatUsageStatsValue(confirmedZero, complete, "cost", false, true)).toBe("$0.00");
  });

  it("formats the corrected KST week, month, and full-period ranges", () => {
    expect(formatUsageStatsPeriodLabel("week", "2026-10-12", "2026-10-19"))
      .toBe("10월 12일 ~ 18일");
    expect(formatUsageStatsPeriodLabel("month", "2026-10-01", "2026-11-01"))
      .toBe("2026년 10월");
    expect(formatUsageStatsPeriodLabel("all", "2026-09-01", "2026-10-19"))
      .toBe("2026년 9월 ~ 10월");
    expect(formatUsageStatsDateWithWeekday("2026-10-16")).toBe("10월 16일 (금)");
  });

  it("uses KST civil dates and includes the current day in effective ranges", () => {
    expect(usageStatsKstDate("2026-10-19T15:00:01Z")).toBe("2026-10-20");
    expect(usageStatsKstDate(Date.parse("2026-10-19T15:00:01Z"))).toBe("2026-10-20");
    expect(usageStatsKstDate("2026-10-31T15:00:01Z")).toBe("2026-11-01");
    expect(usageStatsCalendarRange("week", "2026-10-20")).toEqual({
      since: "2026-10-19", until: "2026-10-26", bucket: "day",
    });
    expect(usageStatsCalendarRange("month", "2026-10-20")).toEqual({
      since: "2026-10-01", until: "2026-11-01", bucket: "day",
    });
    expect(usageStatsRange("all", "2026-10-20", "2026-10-19T15:00:01Z", "2026-09-01"))
      .toMatchObject({ since: "2026-09-01", until: "2026-10-21", effective_until: "2026-10-21" });
    expect(usageStatsRange("week", "2026-10-20", "2026-10-19T15:00:01Z", "2026-09-01"))
      .toMatchObject({ since: "2026-10-19", until: "2026-10-26", effective_until: "2026-10-21" });
    expect(usageStatsMonthAnchor("2026-10-01", "2026-10-19T15:00:01Z")).toBe("2026-10-20");
    expect(usageStatsMonthAnchor("2026-10-01", "2026-10-01T00:00:00+09:00")).toBe("2026-10-01");
  });

  it("keeps calendar buckets half-open at the effective end", () => {
    expect(usageStatsBucketStarts({
      since: "2026-10-19", until: "2026-10-26", effective_until: "2026-10-21", bucket: "day",
    })).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(usageStatsBucketStarts({
      since: "2026-09-25", until: "2026-11-02", effective_until: "2026-11-01", bucket: "month",
    })).toEqual(["2026-09-01", "2026-10-01"]);
    expect(usageStatsBucketStarts({
      since: "2026-09-25", until: "2026-11-02", effective_until: "2026-11-02", bucket: "month",
    })).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
  });

  it("moves anchors by calendar week or month across year boundaries", () => {
    expect(shiftUsageStatsAnchor("week", "2026-10-18", -1)).toBe("2026-10-11");
    expect(shiftUsageStatsAnchor("month", "2026-01-18", -1)).toBe("2025-12-18");
    expect(shiftUsageStatsAnchor("all", "2026-10-18", 1)).toBe("2026-10-18");
  });
});
