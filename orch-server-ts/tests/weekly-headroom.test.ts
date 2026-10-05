import { describe, expect, it } from "vitest";

import {
  computeWeeklyHeadroom,
  resolveWeeklyHeadroom,
} from "../src/usage/weekly_headroom.js";
import type {
  UsageSummaryProvider,
  UsageSummaryQuota,
} from "../src/usage/usage_summary_service.js";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const now = new Date("2026-07-28T03:00:00.000Z");

function provider(
  overrides: Partial<UsageSummaryProvider> = {},
): UsageSummaryProvider {
  return {
    status: "auto",
    weeklyRemainingPercent: null,
    weeklyResetAt: null,
    shortRemainingPercent: null,
    shortResetAt: null,
    quotas: [],
    ...overrides,
  };
}

function quota(overrides: Partial<UsageSummaryQuota> = {}): UsageSummaryQuota {
  return {
    id: "claude:weekly:fable",
    label: "Fable",
    window: "7d",
    model: "Fable",
    remainingPercent: 30,
    resetAt: now.getTime() / 1_000 + WEEK_SECONDS,
    ...overrides,
  };
}

describe("computeWeeklyHeadroom", () => {
  it("subtracts the exact fraction of the seven-day window and rounds headroom", () => {
    const resetAt = now.getTime() / 1_000 + 565_488;

    expect(computeWeeklyHeadroom(83, resetAt, now)).toEqual({
      headroom: -10.5,
      window_remaining_percent: 93.5,
    });
  });

  it("uses zero remaining window when the reset has already passed", () => {
    expect(computeWeeklyHeadroom(42, now.getTime() / 1_000 - 1, now)).toEqual({
      headroom: 42,
      window_remaining_percent: 0,
    });
  });
});

describe("resolveWeeklyHeadroom", () => {
  it("chooses the lowest headroom among the provider window and applicable quota candidates", () => {
    const resetAt = now.getTime() / 1_000 + WEEK_SECONDS;
    expect(resolveWeeklyHeadroom(
      provider({
        weeklyRemainingPercent: 83,
        weeklyResetAt: now.getTime() / 1_000 + 565_488,
        observedAt: now.toISOString(),
      }),
      [quota({ remainingPercent: 30, resetAt })],
      false,
      now,
    )).toEqual({
      status: "ok",
      headroom: -70,
      remaining_percent: 30,
      window_remaining_percent: 100,
      resets_at: new Date(resetAt * 1_000).toISOString(),
      observed_at: now.toISOString(),
      quota_label: "Fable",
    });
  });

  it("returns unavailable with null numeric values when no weekly numbers exist", () => {
    expect(resolveWeeklyHeadroom(provider(), [], false, now)).toMatchObject({
      status: "unavailable",
      headroom: null,
      remaining_percent: null,
      window_remaining_percent: null,
    });
  });

  it("returns unavailable for an errored provider even if it has old numbers", () => {
    expect(resolveWeeklyHeadroom(provider({
      status: "error",
      weeklyRemainingPercent: 72,
      weeklyResetAt: now.getTime() / 1_000 + WEEK_SECONDS,
    }), [], false, now).status).toBe("unavailable");
  });
});
