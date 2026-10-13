import { describe, expect, it } from "vitest";

import {
  findUsageSummaryNode,
  formatUsageResetCountdown,
  formatUsageUpdatedLabel,
  formatWeeklyRemainingPercent,
  maxWeeklyUsageGaugeCount,
  nextUsageSummaryNodeId,
  selectUsageSummaryNode,
  weeklyUsageGauges,
  type UsageSummaryNode,
  type UsageSummarySnapshot,
} from "./usage-summary";

const emptyProvider = {
  status: "auto" as const,
  weeklyRemainingPercent: null,
  weeklyResetAt: null,
  shortRemainingPercent: null,
  shortResetAt: null,
  quotas: [],
};

function node(
  nodeId: string,
  providers: Partial<UsageSummaryNode["providers"]> = {},
): UsageSummaryNode {
  return {
    nodeId,
    fetchedAt: null,
    stale: false,
    staleSince: null,
    providers: {
      claude: null,
      codex: null,
      gemini: null, antigravity: null,
      ...providers,
    },
  };
}

describe("usage summary projection", () => {
  it("matches only the PAS node and never chooses a fallback", () => {
    const summary: UsageSummarySnapshot = {
      generatedAt: "2026-10-11T00:00:00.000Z",
      collectedAt: null,
      nodes: [node("other-node"), node("pas-node")],
    };

    expect(findUsageSummaryNode(summary, "pas-node")?.nodeId).toBe("pas-node");
    expect(findUsageSummaryNode(summary, "missing-node")).toBeNull();
    expect(findUsageSummaryNode(summary, null)).toBeNull();
    expect(findUsageSummaryNode(null, "pas-node")).toBeNull();
  });

  it("selects the stored node, then the PAS node, then the first response node", () => {
    const summary: UsageSummarySnapshot = {
      generatedAt: "2026-10-11T00:00:00.000Z",
      collectedAt: null,
      nodes: [node("first-node"), node("pas-node"), node("stored-node")],
    };

    expect(selectUsageSummaryNode(summary, "pas-node", "stored-node")?.nodeId).toBe("stored-node");
    expect(selectUsageSummaryNode(summary, "pas-node", "missing-node")?.nodeId).toBe("pas-node");
    expect(selectUsageSummaryNode(summary, "missing-node", null)?.nodeId).toBe("first-node");
    expect(selectUsageSummaryNode({ ...summary, nodes: [] }, "pas-node", null)).toBeNull();
    expect(selectUsageSummaryNode(null, "pas-node", null)).toBeNull();
  });

  it("cycles in response order, including stale nodes without gauges, and keeps the maximum slot count", () => {
    const fableQuota = {
      id: "claude:weekly_scoped:fable",
      label: "Fable",
      window: "7d",
      model: null,
      remainingPercent: 55,
      resetAt: null,
    };
    const threeGauges = node("three-gauges", {
      claude: { ...emptyProvider, weeklyRemainingPercent: 73, quotas: [fableQuota] },
      codex: { ...emptyProvider, weeklyRemainingPercent: 42 },
    });
    const noGauges = { ...node("no-gauges"), stale: true };
    const twoGauges = node("two-gauges", {
      claude: { ...emptyProvider, weeklyRemainingPercent: 61 },
      codex: { ...emptyProvider, weeklyRemainingPercent: 38 },
    });
    const summary: UsageSummarySnapshot = {
      generatedAt: "2026-10-11T00:00:00.000Z",
      collectedAt: null,
      nodes: [threeGauges, noGauges, twoGauges],
    };

    expect(nextUsageSummaryNodeId(summary, "three-gauges")).toBe("no-gauges");
    expect(nextUsageSummaryNodeId(summary, "no-gauges")).toBe("two-gauges");
    expect(nextUsageSummaryNodeId(summary, "two-gauges")).toBe("three-gauges");
    expect(nextUsageSummaryNodeId(summary, "missing-node")).toBe("no-gauges");
    expect(nextUsageSummaryNodeId({ ...summary, nodes: [twoGauges] }, "two-gauges")).toBe("two-gauges");
    expect(nextUsageSummaryNodeId({ ...summary, nodes: [] }, "three-gauges")).toBeNull();
    expect(nextUsageSummaryNodeId(null, "three-gauges")).toBeNull();
    expect(weeklyUsageGauges(threeGauges)).toHaveLength(3);
    expect(weeklyUsageGauges(twoGauges)).toHaveLength(2);
    expect(maxWeeklyUsageGaugeCount(summary)).toBe(3);
    expect(maxWeeklyUsageGaugeCount({ ...summary, nodes: [] })).toBe(0);
    expect(maxWeeklyUsageGaugeCount(null)).toBe(0);
  });

  it("uses Claude, the first matching Fable scoped quota, then Codex while preserving zero", () => {
    const firstFable = {
      id: "claude:weekly_scoped:fable-first",
      label: "First Fable",
      window: "7d",
      model: null,
      remainingPercent: null,
      resetAt: 800,
    };
    const providers: UsageSummaryNode["providers"] = {
      claude: {
        ...emptyProvider,
        weeklyRemainingPercent: 0,
        weeklyResetAt: 100,
        quotas: [
          firstFable,
          { ...firstFable, id: "claude:weekly_scoped:fable-second", remainingPercent: 45 },
          { ...firstFable, id: "claude:weekly_scoped:other", label: "Other", remainingPercent: 91 },
          { ...firstFable, id: "claude:weekly_scoped:fable-short", window: "5h", remainingPercent: 92 },
        ],
      },
      codex: { ...emptyProvider, weeklyRemainingPercent: 73, weeklyResetAt: 300 },
      gemini: { ...emptyProvider, weeklyRemainingPercent: 99, weeklyResetAt: 500 },
    };

    expect(weeklyUsageGauges(node("pas-node", providers))).toEqual([
      { id: "claude", label: "Claude", remainingPercent: 0, resetAt: 100 },
      { id: "codex", label: "Codex", remainingPercent: 73, resetAt: 300 },
    ]);
  });

  it("rounds percentages away from zero at ties", () => {
    expect(formatWeeklyRemainingPercent(19.49)).toBe("19%");
    expect(formatWeeklyRemainingPercent(19.5)).toBe("20%");
    expect(formatWeeklyRemainingPercent(-19.5)).toBe("-20%");
  });

  it("formats reset epoch seconds against the supplied millisecond evaluation time", () => {
    const nowMs = 1_000_000;
    expect(formatUsageResetCountdown(91_061, nowMs, false)).toBe("1일 1시간");
    expect(formatUsageResetCountdown(91_061, nowMs, true)).toBe("1일");
    expect(formatUsageResetCountdown(4_599, nowMs, false)).toBe("59분");
    expect(formatUsageResetCountdown(999, nowMs, false)).toBe("0분");
    expect(formatUsageResetCountdown(0, nowMs, false)).toBe("0분");
    expect(formatUsageResetCountdown(null, nowMs, false)).toBeNull();
  });

  it("formats the node fetchedAt and stale label without substituting generatedAt", () => {
    const date = new Date(2026, 9, 11, 1, 9);
    const fetchedAt = new Date(date.getTime()).toISOString();

    expect(formatUsageUpdatedLabel(fetchedAt, false)).toBe("10/11 01:09 갱신");
    expect(formatUsageUpdatedLabel(fetchedAt, true)).toBe("마지막 10/11 01:09 갱신");
    expect(formatUsageUpdatedLabel(null, false)).toBe("갱신 대기 중");
    expect(formatUsageUpdatedLabel("invalid", false)).toBe("갱신 대기 중");
  });
});

it("keeps PAS gauges limited to Claude, Fable and Codex with Antigravity data present", () => {
  const providers = { ...emptyProvider, weeklyRemainingPercent: 99, weeklyResetAt: 1792500000 };
  expect(weeklyUsageGauges(node("agy", { antigravity: providers }))).toEqual([]);
  const original = node("all", { claude: providers, codex: providers });
  expect(weeklyUsageGauges(node("all", { ...original.providers, antigravity: providers }))).toEqual(weeklyUsageGauges(original));
});
