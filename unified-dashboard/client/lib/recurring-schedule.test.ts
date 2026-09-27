import { describe, expect, it } from "vitest";

import {
  defaultRecurringSchedule,
  recurringScheduleExpressions,
  recurringScheduleFromExpressions,
} from "./recurring-schedule";

describe("recurring schedule selection", () => {
  it("keeps recurring as the default while providing a rounded local hour for once mode", () => {
    const startedAt = new Date();
    const draft = defaultRecurringSchedule();
    const localRunAt = new Date(draft.runAtLocal);

    expect(draft.mode).toBe("weekdays");
    expect(draft.runAtLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(localRunAt.getTime()).toBeGreaterThan(startedAt.getTime());
    expect(localRunAt.getTime()).toBeLessThanOrEqual(startedAt.getTime() + 60 * 60 * 1_000);
    expect(localRunAt.getMinutes()).toBe(0);
    expect(localRunAt.getSeconds()).toBe(0);
  });

  it("serializes selected weekdays and multiple times as canonical cron rows", () => {
    expect(recurringScheduleExpressions({
      ...defaultRecurringSchedule(),
      mode: "weekdays",
      times: ["09:00", "12:00"],
    })).toEqual(["0 9 * * 1-5", "0 12 * * 1-5"]);
  });

  it("covers daily, weekly, and monthly selections", () => {
    expect(recurringScheduleExpressions({
      ...defaultRecurringSchedule(), mode: "daily", times: ["07:30"],
    })).toEqual(["30 7 * * *"]);
    expect(recurringScheduleExpressions({
      ...defaultRecurringSchedule(), mode: "weekly", weekdays: [1, 3], times: ["09:00"],
    })).toEqual(["0 9 * * 1,3"]);
    expect(recurringScheduleExpressions({
      ...defaultRecurringSchedule(), mode: "monthly", monthDays: [1, 15], times: ["12:00"],
    })).toEqual(["0 12 1,15 * *"]);
  });

  it("keeps non-structured schedules in the advanced editor exactly", () => {
    const draft = recurringScheduleFromExpressions(["0 9 */2 * *", "0 12 * * 1-5"]);
    expect(draft.mode).toBe("advanced");
    expect(recurringScheduleExpressions(draft)).toEqual(["0 9 */2 * *", "0 12 * * 1-5"]);
  });

  it("opens legacy comma-separated times in the structured editor without changing its schedule", () => {
    const draft = recurringScheduleFromExpressions(["0 9,12 * * 1-5"]);
    expect(draft.mode).toBe("weekdays");
    expect(draft.times).toEqual(["09:00", "12:00"]);
    expect(recurringScheduleExpressions(draft)).toEqual(["0 9 * * 1-5", "0 12 * * 1-5"]);
  });
});
