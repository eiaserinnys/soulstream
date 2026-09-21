import { describe, expect, it } from "vitest";

import {
  defaultRecurringSchedule,
  recurringScheduleExpressions,
  recurringScheduleFromExpressions,
} from "./recurring-schedule";

describe("recurring schedule selection", () => {
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
