import { describe, expect, it } from "vitest";

import { formatUsageStatsModelLabel } from "./usage-stats-format";

describe("usage statistics model labels", () => {
  it("uses the catalogue label first, then the raw model, then the unknown wording", () => {
    expect(formatUsageStatsModelLabel("claude-opus-5-5", "Claude Opus 5.5"))
      .toBe("Claude Opus 5.5");
    expect(formatUsageStatsModelLabel("vendor/team:model:v2", "Vendor Model"))
      .toBe("Vendor Model");
    expect(formatUsageStatsModelLabel("vendor/team:model:v2", null))
      .toBe("vendor/team:model:v2");
    expect(formatUsageStatsModelLabel("vendor/team:model:v2"))
      .toBe("vendor/team:model:v2");
    expect(formatUsageStatsModelLabel("vendor/team:model:v2", ""))
      .toBe("vendor/team:model:v2");
    expect(formatUsageStatsModelLabel(null, "Vendor Model")).toBe("Vendor Model");
    expect(formatUsageStatsModelLabel(null)).toBe("모델 미상");
    expect(formatUsageStatsModelLabel(undefined)).toBe("모델 미상");
  });

  it("keeps no model display-name table in the formatter", () => {
    expect(formatUsageStatsModelLabel("claude-opus-5.5")).toBe("claude-opus-5.5");
    expect(formatUsageStatsModelLabel("claude-sonnet-5.5")).toBe("claude-sonnet-5.5");
    expect(formatUsageStatsModelLabel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(formatUsageStatsModelLabel("kimi-for-coding/k3")).toBe("kimi-for-coding/k3");
  });
});
