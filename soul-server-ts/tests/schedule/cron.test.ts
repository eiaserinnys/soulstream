import { describe, expect, it } from "vitest";

import { nextCronRunAt, parseCronExpression } from "../../src/schedule/cron.js";

describe("Soulstream durable schedule cron parser", () => {
  it("computes the next UTC minute and skips missed recurring intervals", () => {
    expect(
      nextCronRunAt("*/15 * * * *", new Date("2026-01-01T00:10:05Z")).toISOString(),
    ).toBe("2026-01-01T00:15:00.000Z");

    expect(
      nextCronRunAt("*/15 * * * *", new Date("2026-01-01T00:59:59Z")).toISOString(),
    ).toBe("2026-01-01T01:00:00.000Z");
  });

  it("supports ranges, lists, and Sunday 7 alias", () => {
    const cron = parseCronExpression("5,10 9-11 * * 0,7");

    expect(cron.minute.values.has(5)).toBe(true);
    expect(cron.minute.values.has(10)).toBe(true);
    expect(cron.hour.values.has(9)).toBe(true);
    expect(cron.hour.values.has(11)).toBe(true);
    expect(cron.dayOfWeek.values.has(0)).toBe(true);
    expect(cron.dayOfWeek.values.has(7)).toBe(true);
  });

  it("matches cron fields in the requested IANA timezone while storing UTC instants", () => {
    expect(
      nextCronRunAt(
        "0 9 * * *",
        new Date("2026-01-01T23:00:00Z"),
        "Asia/Seoul",
      ).toISOString(),
    ).toBe("2026-01-02T00:00:00.000Z");
  });

  it("rejects invalid cron expressions before they reach the durable store", () => {
    expect(() => parseCronExpression("* * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCronExpression("60 * * * *")).toThrow(/outside range/);
    expect(() => parseCronExpression("*/0 * * * *")).toThrow(/must be >= 1/);
    expect(() => nextCronRunAt("* * * * *", new Date(), "Invalid/Timezone")).toThrow();
  });
});
