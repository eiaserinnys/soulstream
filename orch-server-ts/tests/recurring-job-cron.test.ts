import { describe, expect, it } from "vitest";

import {
  compileRecurringSchedule,
  nextRecurringOccurrences,
} from "../src/recurring-jobs/cron.js";

describe("recurring job cron compiler", () => {
  it("normalizes weekday multiple times and deduplicates an absolute minute", () => {
    const schedule = compileRecurringSchedule({
      timezone: "Asia/Seoul",
      scheduleExpressions: ["0 9,12 * * 1-5", "0 9 * * 1-5"],
    });

    expect(schedule.scheduleExpressions).toEqual(["0 9,12 * * 1-5", "0 9 * * 1-5"]);
    expect(nextRecurringOccurrences(
      schedule,
      new Date("2026-09-20T15:00:00.000Z"),
      5,
    ).map((value) => value.toISOString())).toEqual([
      "2026-09-21T00:00:00.000Z",
      "2026-09-21T03:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
      "2026-09-22T03:00:00.000Z",
      "2026-09-23T00:00:00.000Z",
    ]);
  });

  it("uses the first fall-back local minute and skips a spring-forward missing minute", () => {
    const fallBack = compileRecurringSchedule({
      timezone: "America/New_York",
      scheduleExpressions: ["30 1 * * *"],
    });
    expect(nextRecurringOccurrences(
      fallBack,
      new Date("2026-11-01T04:00:00.000Z"),
      2,
    ).map((value) => value.toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);

    const springForward = compileRecurringSchedule({
      timezone: "America/New_York",
      scheduleExpressions: ["30 2 * * *"],
    });
    expect(nextRecurringOccurrences(
      springForward,
      new Date("2026-03-08T05:00:00.000Z"),
      1,
    ).map((value) => value.toISOString())).toEqual([
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("rejects invalid five-field cron expressions and timezones", () => {
    expect(() => compileRecurringSchedule({
      timezone: "Asia/Seoul",
      scheduleExpressions: ["0 9 * *"],
    })).toThrow(/five fields/i);
    expect(() => compileRecurringSchedule({
      timezone: "not/a-timezone",
      scheduleExpressions: ["0 9 * * 1-5"],
    })).toThrow(/timezone/i);
  });
});
