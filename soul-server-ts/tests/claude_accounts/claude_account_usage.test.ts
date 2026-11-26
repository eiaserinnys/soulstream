import { describe, expect, it } from "vitest";
import type { ClaudeAccountUsage } from "@soulstream/wire-schema";
import {
  effectiveWindowResetMs,
  effectiveWindowUsedPercent,
  isUsageExhaustedForScope,
  usageExhaustionResetMs,
} from "@soulstream/wire-schema/claude-account-usage";

const NOW = Date.parse("2026-11-26T00:00:00.000Z");
const FUTURE_A = "2026-11-26T03:00:00.000Z";
const FUTURE_B = "2026-12-01T00:00:00.000Z";
const PAST = "2026-11-25T00:00:00.000Z";

function usage(overrides: Partial<ClaudeAccountUsage>): ClaudeAccountUsage {
  return { five_hour: null, seven_day: null, fable_weekly: null, ...overrides };
}

describe("shared Claude account usage judgement", () => {
  it("reads a window as 0 percent once its reset time has passed", () => {
    expect(effectiveWindowUsedPercent({ used_percent: 100, resets_at: PAST }, NOW)).toBe(0);
    expect(effectiveWindowUsedPercent({ used_percent: 100, resets_at: FUTURE_A }, NOW)).toBe(100);
    expect(effectiveWindowUsedPercent({ used_percent: Number.NaN, resets_at: null }, NOW)).toBeNull();
    expect(effectiveWindowUsedPercent(null, NOW)).toBeNull();
  });

  it("returns a window's reset time only while it is still in the future", () => {
    expect(effectiveWindowResetMs({ used_percent: 10, resets_at: FUTURE_A }, NOW)).toBe(Date.parse(FUTURE_A));
    expect(effectiveWindowResetMs({ used_percent: 10, resets_at: PAST }, NOW)).toBeNull();
    expect(effectiveWindowResetMs({ used_percent: 10, resets_at: null }, NOW)).toBeNull();
  });

  it("counts the Fable weekly window only for the fable scope", () => {
    const fableFull = usage({ fable_weekly: { used_percent: 100, resets_at: FUTURE_A } });
    expect(isUsageExhaustedForScope(fableFull, "all", NOW)).toBe(false);
    expect(isUsageExhaustedForScope(fableFull, "fable", NOW)).toBe(true);
  });

  it("treats exactly 100 percent as exhausted and ignores a window that already reset", () => {
    expect(isUsageExhaustedForScope(usage({ five_hour: { used_percent: 99.9, resets_at: FUTURE_A } }), "all", NOW)).toBe(false);
    expect(isUsageExhaustedForScope(usage({ five_hour: { used_percent: 100, resets_at: FUTURE_A } }), "all", NOW)).toBe(true);
    expect(isUsageExhaustedForScope(usage({ five_hour: { used_percent: 100, resets_at: PAST } }), "all", NOW)).toBe(false);
  });

  it("releases exhaustion at the latest reset, or never when one reset time is unknown", () => {
    const both = usage({
      five_hour: { used_percent: 100, resets_at: FUTURE_A },
      seven_day: { used_percent: 100, resets_at: FUTURE_B },
    });
    expect(usageExhaustionResetMs(both, "all", NOW)).toBe(Date.parse(FUTURE_B));
    const unknown = usage({
      five_hour: { used_percent: 100, resets_at: FUTURE_A },
      seven_day: { used_percent: 100, resets_at: null },
    });
    expect(usageExhaustionResetMs(unknown, "all", NOW)).toBeNull();
    expect(usageExhaustionResetMs(usage({}), "all", NOW)).toBeNull();
  });
});
