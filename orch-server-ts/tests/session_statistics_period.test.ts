import { describe, expect, it } from "vitest";

import {
  resolveSessionStatisticsDay,
  resolveSessionStatisticsPeriod,
} from "../src/usage/session_statistics_period.js";
import type { UsageStatsQuery } from "@soulstream/wire-schema/session-statistics";

const asOf = "2026-10-19T15:00:01.000Z";

function query(period: UsageStatsQuery["period"], anchor = "2026-10-20"): UsageStatsQuery {
  return { period, anchor };
}

describe("session statistics period", () => {
  it("uses the KST week containing today and caps reads at asOf", () => {
    expect(resolveSessionStatisticsPeriod(query("week"), asOf, null)).toEqual({
      range: {
        period: "week",
        since: "2026-10-19",
        until: "2026-10-26",
        effective_until: "2026-10-21",
        timezone: "Asia/Seoul",
        bucket: "day",
      },
      recordedAtFrom: "2026-10-18T15:00:00.000Z",
      recordedAtBefore: asOf,
      empty: false,
    });
  }, 60_000);

  it("uses the authorized retained earliest date for all and today for an empty scope", () => {
    expect(resolveSessionStatisticsPeriod(
      query("all"),
      asOf,
      "2026-09-17T14:59:00.000Z",
    ).range.since).toBe("2026-09-17");
    expect(resolveSessionStatisticsPeriod(query("all"), asOf, null).range.since).toBe("2026-10-20");
  }, 60_000);

  it("represents future calendar ranges as empty without reversing the date range", () => {
    expect(resolveSessionStatisticsPeriod(query("week", "2026-10-26"), asOf, null)).toEqual({
      range: {
        period: "week",
        since: "2026-10-26",
        until: "2026-11-02",
        effective_until: "2026-10-26",
        timezone: "Asia/Seoul",
        bucket: "day",
      },
      recordedAtFrom: "2026-10-25T15:00:00.000Z",
      recordedAtBefore: asOf,
      empty: true,
    });
  }, 60_000);

  it("intersects a selected day with the fixed range and asOf", () => {
    const period = resolveSessionStatisticsPeriod(query("month"), asOf, null);
    expect(resolveSessionStatisticsDay("2026-10-20", period.range, asOf)).toEqual({
      recordedAtFrom: "2026-10-19T15:00:00.000Z",
      recordedAtBefore: asOf,
    });
  }, 60_000);

  it("rejects invalid dates, timestamps without offsets, and days outside the period", () => {
    expect(() => resolveSessionStatisticsPeriod(
      query("week", "2026-02-30"), asOf, null,
    )).toThrow();
    expect(() => resolveSessionStatisticsPeriod(
      query("week"), "2026-10-19T15:00:01", null,
    )).toThrow();
    const period = resolveSessionStatisticsPeriod(query("week"), asOf, null);
    expect(() => resolveSessionStatisticsDay("2026-10-21", period.range, asOf)).toThrow();
  }, 60_000);
});
