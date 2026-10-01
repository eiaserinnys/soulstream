import { describe, expect, it } from "vitest";
import { strictOrchestrationUsage } from "../src/cards/orchestration_usage.js";
import type { UsageSummaryProvider, UsageSummarySnapshot, UsageSummaryQuota } from "../src/usage/usage_summary_service.js";

const now = new Date("2026-10-01T12:00:00Z");
const preset = { usage_provider: "codex" as const, usage_model_id: "gpt-6-astra" };
function quota(remainingPercent: number | null, fields: Partial<UsageSummaryQuota> = {}): UsageSummaryQuota {
  return { id: "codex:5h", label: "5시간", window: "5h", model: null, remainingPercent, resetAt: 1, source: "codex-usage-api", purpose: "execution", ...fields };
}
function snapshot(fields: Partial<UsageSummaryProvider> = {}, stale = false): UsageSummarySnapshot {
  return { generatedAt: now.toISOString(), collectedAt: now.toISOString(), nodes: [{ nodeId: "node", fetchedAt: now.toISOString(), stale, staleSince: null, providers: { claude: null, gemini: null, codex: { status: "auto", weeklyRemainingPercent: null, weeklyResetAt: null, shortRemainingPercent: null, shortResetAt: null, observedAt: now.toISOString(), source: "codex-usage-api", sourceKind: "remote", quotas: [quota(15)], ...fields } } }] };
}
describe("strict orchestration quota admission", () => {
  it("admits exactly 15% fresh global and matching model execution windows and preserves evidence", () => {
    const result = strictOrchestrationUsage("node", preset, snapshot({ quotas: [quota(80), quota(15, { id: "astra:7d", model: "GPT-6-Astra" }), quota(0, { id: "codex:code_review", purpose: "code_review" }), quota(0, { model: "unrelated" })] }), now, 15);
    expect(result).toMatchObject({ available: true, reason: null, minimumRemainingPercent: 15, observedAt: now.toISOString(), sourceKind: "remote" });
    expect(result.quotas.map(q => q.id)).toEqual(["codex:5h", "astra:7d"]);
  });
  it("denies low quota after reset passes until genuinely refreshed data arrives", () => {
    expect(strictOrchestrationUsage("node", preset, snapshot({ quotas: [quota(0)] }), now, 15).reason).toBe("quota_below_threshold");
    expect(strictOrchestrationUsage("node", preset, snapshot({ quotas: [quota(100)] }), now, 15).available).toBe(true);
  });
  it("allows age exactly five minutes but denies older or future source samples, regardless of fresh wrapper", () => {
    expect(strictOrchestrationUsage("node", preset, snapshot({ observedAt: "2026-10-01T11:55:00Z" }), now, 15).available).toBe(true);
    expect(strictOrchestrationUsage("node", preset, snapshot({ observedAt: "2026-10-01T11:54:59.999Z" }), now, 15).reason).toBe("usage_stale");
    expect(strictOrchestrationUsage("node", preset, snapshot({ observedAt: "2026-10-01T12:00:01Z" }), now, 15).reason).toBe("usage_stale");
  });
  it.each([undefined, null, "invalid"])("denies absent or unparseable source time %s", observedAt => {
    expect(strictOrchestrationUsage("node", preset, snapshot({ observedAt }), now, 15).reason).toBe("usage_unproven");
  });
  it("denies absent source, old fallback and error/stale collector states", () => {
    expect(strictOrchestrationUsage("node", preset, snapshot({ source: null }), now, 15).reason).toBe("usage_unproven");
    expect(strictOrchestrationUsage("node", preset, snapshot({ sourceKind: "rollout", observedAt: null }), now, 15).reason).toBe("usage_unproven");
    expect(strictOrchestrationUsage("node", preset, snapshot({ status: "error" }), now, 15).reason).toBe("usage_unavailable");
    expect(strictOrchestrationUsage("node", preset, snapshot({}, true), now, 15).reason).toBe("usage_stale");
  });
  it("rejects missing applicable execution quota or unknown percentages", () => {
    expect(strictOrchestrationUsage("node", preset, snapshot({ quotas: [quota(100, { purpose: "code_review" })] }), now, 15).reason).toBe("no_execution_quota");
    expect(strictOrchestrationUsage("node", preset, snapshot({ quotas: [quota(null)] }), now, 15).reason).toBe("quota_unknown");
    expect(strictOrchestrationUsage("node", preset, snapshot({ quotas: [quota(100, { purpose: undefined })] }), now, 15).reason).toBe("no_execution_quota");
  });
  it("denies unsupported provider and missing node without ordinary availability fallback", () => {
    expect(strictOrchestrationUsage("node", { usage_provider: null }, snapshot(), now, 15).reason).toBe("usage_unavailable");
    expect(strictOrchestrationUsage("missing", preset, snapshot(), now, 15).reason).toBe("usage_unavailable");
  });
});
