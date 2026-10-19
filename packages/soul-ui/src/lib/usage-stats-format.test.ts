import { describe, expect, it } from "vitest";

import {
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsPeriodLabel,
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
  isUsageStatsTokenPartial,
  shiftUsageStatsAnchor,
  usageStatsMonthAnchor,
  usageStatsModelColorIndex,
  formatUsageStatsChars,
  formatUsageStatsValue,
  usageStatsRange,
} from "./usage-stats-format";

describe("usage statistics formatting", () => {
  it("shares month drilldown anchors, stable model ranks, and observed character units", () => {
    expect(usageStatsMonthAnchor("2026-10-01", "2026-10-19T00:00:00+09:00")).toBe("2026-10-18");
    expect(usageStatsMonthAnchor("2026-09-01", "2026-10-19T00:00:00+09:00")).toBe("2026-09-30");
    expect(usageStatsRange("week", usageStatsMonthAnchor("2026-09-01", "2026-10-19"), "2026-10-19", "2026-09-01")).toMatchObject({ since: "2026-09-28", until: "2026-10-05" });
    expect(usageStatsModelColorIndex("sonnet", ["opus", "sonnet"])).toBe(1);
    expect(usageStatsModelColorIndex(null, ["opus", "sonnet"])).toBe(-1);
    expect(formatUsageStatsChars(1132000, true)).toBe("관측 1,132,000자");
    expect(formatUsageStatsChars(1132000)).toBe("1,132,000자");
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

  it("moves anchors by calendar week or month across year boundaries", () => {
    expect(shiftUsageStatsAnchor("week", "2026-10-18", -1)).toBe("2026-10-11");
    expect(shiftUsageStatsAnchor("month", "2026-01-18", -1)).toBe("2025-12-18");
    expect(shiftUsageStatsAnchor("all", "2026-10-18", 1)).toBe("2026-10-18");
  });
});
