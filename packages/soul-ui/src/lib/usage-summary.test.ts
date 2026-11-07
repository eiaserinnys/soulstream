import { describe, expect, it } from "vitest";

import {
  findUsageSummaryNode,
  formatUsageResetCountdown,
  formatUsageUpdatedLabel,
  formatWeeklyRemainingPercent,
  nextUsageSummaryNodeId,
  providerQuotaSlots,
  selectUsageSummaryNode,
  weeklyUsageGauges,
  type UsageSummaryNode,
  type UsageSummaryProvider,
  type UsageSummaryQuota,
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
      antigravity: null,
      opencode_go: null,
      ...providers,
    },
  };
}

describe("usage summary projection", () => {
  it("accepts Claude account-pool metadata on the shared provider contract", () => {
    const provider: UsageSummaryProvider = {
      ...emptyProvider,
      mode: "pool",
      accounts: [],
      pool: {
        available_count: 0,
        total_count: 0,
        best_weekly_remaining_percent: null,
        best_weekly_resets_at: null,
        earliest_available_at: null,
      },
      fable_pool: null,
    };

    expect(provider).toMatchObject({ mode: "pool", accounts: [], pool: { total_count: 0 }, fable_pool: null });
  });

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

  it("cycles in response order, including stale nodes without gauges", () => {
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
      antigravity: null,
      opencode_go: null,
    };

    const legacyProviders = { ...providers, gemini: { ...emptyProvider, weeklyRemainingPercent: 99 } };
    expect(weeklyUsageGauges(node("pas-node", legacyProviders))).toEqual([
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

function quota(
  id: string,
  label: string,
  window: string | null,
  model: string | null,
  remainingPercent: number | null,
  resetAt: number | null = null,
  purpose?: UsageSummaryQuota["purpose"],
): UsageSummaryQuota {
  return { id, label, window, model, remainingPercent, resetAt, purpose };
}

function provider(
  quotas: readonly UsageSummaryQuota[],
  status: UsageSummaryProvider["status"] = "auto",
): UsageSummaryProvider {
  return { ...emptyProvider, status, quotas };
}

describe("provider quota slots", () => {
  it("lays out the Claude account pool as short, weekly and Fable", () => {
    expect(providerQuotaSlots(provider([
      quota("claude:five_hour", "5시간", "5h", null, 74, 1_200),
      quota("claude:seven_day", "7일", "7d", null, 52, 2_400),
      quota("claude:weekly_scoped:fable", "Fable", "7d", "fable", 31, 3_600),
    ]))).toEqual([
      { kind: "short", label: "5시간", usedPercent: 26, resetAt: 1_200 },
      { kind: "weekly", label: "7일", usedPercent: 48, resetAt: 2_400 },
      { kind: "fable", label: "Fable", usedPercent: 69, resetAt: 3_600 },
    ]);
  });

  it("lays out OpenCode Go monthly as the third slot", () => {
    expect(providerQuotaSlots(provider([
      quota("opencode_go:rolling", "5시간", "5h", null, 88, 600, "execution"),
      quota("opencode_go:weekly", "7일", "7d", null, 41, 7_200, "execution"),
      quota("opencode_go:monthly", "월", "monthly", null, 12, 43_200, "execution"),
    ]))).toEqual([
      { kind: "short", label: "5시간", usedPercent: 12, resetAt: 600 },
      { kind: "weekly", label: "7일", usedPercent: 59, resetAt: 7_200 },
      { kind: "monthly", label: "월간", usedPercent: 88, resetAt: 43_200 },
    ]);
  });

  it("keeps a Codex 168h quota in the weekly slot without pulling it forward", () => {
    expect(providerQuotaSlots(provider([
      quota("codex:7d", "7일", "168h", null, 80, 900),
    ]))).toEqual([
      null,
      { kind: "weekly", label: "7일", usedPercent: 20, resetAt: 900 },
      null,
    ]);
  });

  it("skips code review quotas and model-scoped windows", () => {
    expect(providerQuotaSlots(provider([
      quota("codex:5h", "5시간", "5h", null, 64, 300),
      quota("codex:code_review", "리뷰", "5h", null, 5, 300, "code_review"),
      quota("codex:7d", "7일", "168h", null, 70, 900),
      quota("codex:gpt-5:secondary", "gpt-5 7일", "168h", "gpt-5", 30, 900),
    ]))).toEqual([
      { kind: "short", label: "5시간", usedPercent: 36, resetAt: 300 },
      { kind: "weekly", label: "7일", usedPercent: 30, resetAt: 900 },
      null,
    ]);
  });

  it("ignores legacy model-scoped weekly quotas and non-execution monthly credit", () => {
    expect(providerQuotaSlots(provider([
      quota("claude:five_hour", "5시간", "5h", null, 20, 100),
      quota("claude:seven_day", "7일", "7d", null, 40, 200),
      quota("claude:seven_day_sonnet", "Sonnet 7일", "7d", "sonnet", 90, 200),
      quota("claude:monthly_extra", "월간 추가", "monthly", null, 90, 300, "other"),
    ]))).toEqual([
      { kind: "short", label: "5시간", usedPercent: 80, resetAt: 100 },
      { kind: "weekly", label: "7일", usedPercent: 60, resetAt: 200 },
      null,
    ]);
  });

  it("returns empty slots unless the provider is collecting automatically", () => {
    const quotas = [quota("claude:five_hour", "5시간", "5h", null, 20, 100)];
    expect(providerQuotaSlots(null)).toEqual([null, null, null]);
    expect(providerQuotaSlots(provider(quotas, "not_configured"))).toEqual([null, null, null]);
    expect(providerQuotaSlots(provider(quotas, "error"))).toEqual([null, null, null]);
  });

  it("turns remaining percent into used percent and keeps the reset time", () => {
    expect(providerQuotaSlots(provider([
      quota("claude:five_hour", "5시간", "5h", null, 26, 1_700_000_000),
    ]))).toEqual([
      { kind: "short", label: "5시간", usedPercent: 74, resetAt: 1_700_000_000 },
      null,
      null,
    ]);
  });
});

it("appends Antigravity after Claude, Fable and Codex using the weekly window, including zero", () => {
  const providers = { ...emptyProvider, weeklyRemainingPercent: 99, weeklyResetAt: 1792500000 };
  const all = node("all", {
    claude: { ...providers, quotas: [{ id: 'claude:weekly_scoped:fable', label: 'Fable', window: '7d', model: null, remainingPercent: 80, resetAt: 100 }] },
    codex: providers,
    antigravity: { ...providers, weeklyRemainingPercent: 0, shortRemainingPercent: 72, shortResetAt: 200 },
  });
  expect(weeklyUsageGauges(all).map(gauge => gauge.id)).toEqual(['claude', 'fable', 'codex', 'antigravity']);
  expect(weeklyUsageGauges(all).at(-1)).toEqual({ id: 'antigravity', label: 'Antigravity', remainingPercent: 0, resetAt: 1792500000 });
  expect(weeklyUsageGauges(node('missing', { antigravity: emptyProvider }))).toEqual([]);
});
