import type { StaticModelPreset } from "../model/model_preset_availability.js";
import type { UsageSummaryQuota, UsageSummarySnapshot } from "../usage/usage_summary_service.js";

export const ORCHESTRATION_USAGE_MAX_AGE_MS = 300_000;
export type OrchestrationUsageReason = "usage_unavailable" | "usage_stale" | "usage_unproven" | "no_execution_quota" | "quota_unknown" | "quota_below_threshold";
export type OrchestrationUsageEvidence = {
  readonly available: boolean;
  readonly reason: OrchestrationUsageReason | null;
  readonly observedAt: string | null;
  readonly source: string | null;
  readonly sourceKind: "remote" | "rollout" | "unknown";
  readonly minimumRemainingPercent: number | null;
  readonly quotas: readonly UsageSummaryQuota[];
};

/** Strict policy admission. Ordinary/manual model availability remains separate. */
export function strictOrchestrationUsage(
  nodeId: string,
  preset: Pick<StaticModelPreset, "usage_provider" | "usage_model_id">,
  snapshot: UsageSummarySnapshot,
  now: Date,
  minimumRemainingPercent = 15,
): OrchestrationUsageEvidence {
  const node = snapshot.nodes.find(value => value.nodeId === nodeId);
  const provider = preset.usage_provider === null ? null : node?.providers[preset.usage_provider];
  const evidence = {
    observedAt: provider?.observedAt ?? null,
    source: provider?.source ?? null,
    sourceKind: provider?.sourceKind ?? "unknown",
    minimumRemainingPercent: null as number | null,
    quotas: [] as readonly UsageSummaryQuota[],
  };
  const deny = (reason: OrchestrationUsageReason): OrchestrationUsageEvidence => ({ ...evidence, available: false, reason });
  if (!node || !provider || provider.status !== "auto") return deny("usage_unavailable");
  if (node.stale) return deny("usage_stale");
  if (!evidence.source || evidence.sourceKind === "unknown" || !evidence.observedAt) return deny("usage_unproven");
  const observedMs = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedMs)) return deny("usage_unproven");
  const ageMs = now.getTime() - observedMs;
  if (ageMs < 0 || ageMs > ORCHESTRATION_USAGE_MAX_AGE_MS) return deny("usage_stale");
  evidence.quotas = provider.quotas.filter(quota =>
    quota.purpose === "execution" && quota.id !== "codex:code_review" && isApplicable(preset.usage_model_id, quota.model),
  );
  if (evidence.quotas.length === 0) return deny("no_execution_quota");
  if (evidence.quotas.some(quota => quota.remainingPercent === null || !Number.isFinite(quota.remainingPercent) || quota.remainingPercent < 0 || quota.remainingPercent > 100)) return deny("quota_unknown");
  evidence.minimumRemainingPercent = Math.min(...evidence.quotas.map(quota => quota.remainingPercent!));
  // resetAt is evidence only: a past reset never manufactures fresh remaining quota.
  if (evidence.minimumRemainingPercent < minimumRemainingPercent) return deny("quota_below_threshold");
  return { ...evidence, available: true, reason: null };
}

function isApplicable(presetModel: string | undefined, quotaModel: string | null): boolean {
  if (quotaModel === null) return true;
  if (!presetModel) return false;
  const left = identity(presetModel);
  const right = identity(quotaModel);
  return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`);
}
function identity(value: string): string {
  return value.toLowerCase().replace(/\[[^\]]+\]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
