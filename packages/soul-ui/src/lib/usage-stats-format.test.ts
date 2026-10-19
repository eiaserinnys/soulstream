import { describe, expect, it } from "vitest";

import {
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
  usageStatsRange,
} from "./usage-stats-format";

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
    const coverage = { usage_partial_events: 0, missing_usage_turns: 1, unknown_total_token_events: 0, unpriced_events: 0, unattributed_missing_usage: false };
    expect(formatUsageStatsValue({ total_tokens: null, reference_cost_usd: null }, coverage, "cost")).toBe("미확인");
    expect(formatUsageStatsValue({ total_tokens: null, reference_cost_usd: null }, coverage, "cost", true)).toBe("미기록");
    expect(formatUsageStatsValue({ total_tokens: 5, reference_cost_usd: null }, coverage, "cost", true)).toBe("정가 미확인");
    expect(formatUsageStatsValue({ total_tokens: 0, reference_cost_usd: 0 }, coverage, "tokens")).toBe("미기록");
  });
  it("does not mark positive totals partial for pending-only or unknown collection evidence", () => {
    const pendingOnly = {
      usage_partial_events: 0,
      missing_usage_turns: 0,
      unknown_total_token_events: 0,
      unpriced_events: 0,
      unattributed_missing_usage: false,
      pending_inputs: 1,
      collection_state: "unknown",
    };
    expect(formatUsageStatsValue({ total_tokens: 8, reference_cost_usd: null }, pendingOnly, "tokens")).toBe("8");
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
  });

  it("marks token totals partial only for missing or unknown usage", () => {
    expect(isUsageStatsTokenPartial({
      usage_partial_events: 0,
      missing_usage_turns: 0,
      unknown_total_token_events: 0,
      unattributed_missing_usage: false,
    })).toBe(false);
    expect(isUsageStatsTokenPartial({
      usage_partial_events: 1,
      missing_usage_turns: 0,
      unknown_total_token_events: 0,
      unattributed_missing_usage: false,
    })).toBe(true);
    expect(isUsageStatsTokenPartial({
      usage_partial_events: 0,
      missing_usage_turns: 1,
      unknown_total_token_events: 0,
      unattributed_missing_usage: false,
    })).toBe(true);
    expect(isUsageStatsTokenPartial({
      usage_partial_events: 0,
      missing_usage_turns: 0,
      unknown_total_token_events: 1,
      unattributed_missing_usage: false,
    })).toBe(true);
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
