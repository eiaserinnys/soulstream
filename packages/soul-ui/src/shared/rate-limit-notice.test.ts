import { describe, expect, it } from "vitest";

import { formatRateLimitNotice } from "./rate-limit-notice";

describe("formatRateLimitNotice", () => {
  const now = Date.UTC(2026, 8, 26, 0, 0);

  it("shows a five-hour limit, KST reset, and remaining hours/minutes", () => {
    expect(formatRateLimitNotice(
      "Session stopped.",
      "five_hour",
      "2026-09-26T03:12:00.000Z",
      now,
    )).toBe(
      "Session stopped.\n\n5시간 한도 · 해제 시각 9월 26일 12:12 KST · 3시간 12분 남음",
    );
  });

  it("shows weekly duration in days and hours", () => {
    expect(formatRateLimitNotice(
      "Session stopped.",
      "seven_day_sonnet",
      new Date(now + 2 * 24 * 60 * 60_000 + 3 * 60 * 60_000 + 22 * 60_000).toISOString(),
      now,
    )).toContain("2일 3시간 남음");
  });

  it.each([
    [23 * 60 + 59, "23시간 59분 남음"],
    [24 * 60, "1일 남음"],
    [60, "1시간 남음"],
    [59, "59분 남음"],
  ])("formats the %s-minute boundary as %s", (minutes, expected) => {
    expect(formatRateLimitNotice(
      "Session stopped.",
      "five_hour",
      new Date(now + minutes * 60_000).toISOString(),
      now,
    )).toContain(expected);
  });

  it("keeps the known limit type and does not invent a reset", () => {
    expect(formatRateLimitNotice("Session stopped.", "seven_day", undefined, now))
      .toBe("Session stopped.\n\n주간 한도");
  });
});
