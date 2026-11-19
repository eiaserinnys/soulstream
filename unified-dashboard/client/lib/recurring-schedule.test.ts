import { describe, expect, it } from "vitest";

import { defaultRecurringSchedule, recurringScheduleExpressions } from "./recurring-schedule";

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
    expect(recurringScheduleExpressions({ ...defaultRecurringSchedule(), mode: "once" })).toEqual([]);
  });
});
