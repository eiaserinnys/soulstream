import { describe, expect, it } from "vitest";

import { dayRange } from "./UsageLogTab";

describe("usage log day range", () => {
  it("covers the whole local day of the chosen date", () => {
    const { from, to } = dayRange("2026-09-21");
    const start = new Date(from);
    const end = new Date(to);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(21);
    expect(start.getHours()).toBe(0);
    expect(end.getDate()).toBe(21);
    expect(end.getHours()).toBe(23);
  });

  it("sends absolute instants so the server never guesses a timezone", () => {
    const { from, to } = dayRange("2026-09-21");
    expect(from).toMatch(/Z$/);
    expect(to).toMatch(/Z$/);
    expect(Date.parse(to)).toBeGreaterThan(Date.parse(from));
  });

  it("falls back to a usable range when the date input is empty", () => {
    const { from, to } = dayRange("");
    expect(Number.isFinite(Date.parse(from))).toBe(true);
    expect(Number.isFinite(Date.parse(to))).toBe(true);
  });
});
