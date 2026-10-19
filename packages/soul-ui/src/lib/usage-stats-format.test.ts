import { describe, expect, it } from "vitest";

import {
  formatUsageStatsCoverage,
  formatUsageStatsDateWithWeekday,
  formatUsageStatsPeriodLabel,
  formatUsageStatsTokenCount,
  formatUsageStatsUsd,
  shiftUsageStatsAnchor,
} from "./usage-stats-format";

describe("usage statistics formatting", () => {
  it("keeps measured zero distinct from missing data", () => {
    expect(formatUsageStatsTokenCount(0)).toBe("0");
    expect(formatUsageStatsTokenCount(null)).toBe("미기록");
    expect(formatUsageStatsUsd(0)).toBe("$0.00");
    expect(formatUsageStatsUsd(null)).toBe("미확인");
  });

  it("names the observed-token denominator in coverage", () => {
    expect(formatUsageStatsCoverage(8_200, 10_000)).toBe("기록 토큰 82% 환산");
    expect(formatUsageStatsCoverage(1, null)).toBe("일부만 환산");
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
