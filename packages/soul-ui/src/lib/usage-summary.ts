import type { ClaudeAccount, ClaudeAccountPool } from "../../../wire-schema/generated/typescript/index";

export const USAGE_SUMMARY_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export type UsageSummaryProviderName = "claude" | "codex" | "antigravity" | "opencode_go";

export type ClaudeCentralEffectiveNode = {
  readonly node_id: string;
  readonly receive: boolean;
  readonly connected: boolean;
};

export type ClaudeCentralSettings = {
  readonly default_receive: boolean;
  readonly nodes: Readonly<Record<string, boolean>>;
  readonly effective: readonly ClaudeCentralEffectiveNode[];
};

export type UsageSummaryQuota = {
  readonly id: string;
  readonly label: string;
  readonly window: string | null;
  readonly model: string | null;
  readonly remainingPercent: number | null;
  readonly resetAt: number | null;
  readonly source?: string | null;
  readonly purpose?: "execution" | "code_review" | "other";
};

export type UsageSummaryProvider = {
  readonly status: "auto" | "not_configured" | "error";
  /** Present on Claude providers when account-pool metadata is available. */
  readonly mode?: "legacy" | "pool";
  readonly accounts?: readonly ClaudeAccount[];
  readonly pool?: ClaudeAccountPool | null;
  readonly fable_pool?: ClaudeAccountPool | null;
  readonly source?: string | null;
  readonly sourceKind?: "remote" | "rollout" | "unknown";
  readonly observedAt?: string | null;
  readonly weeklyRemainingPercent: number | null;
  readonly weeklyResetAt: number | null;
  readonly shortRemainingPercent: number | null;
  readonly shortResetAt: number | null;
  readonly quotas: readonly UsageSummaryQuota[];
  /**
   * Codex와 Antigravity 행에서 그 노드의 워커가 화면 로그인(agent_login_v1)을 알렸는지.
   * 서버가 아직 이 필드를 주지 않으면 없으므로 없는 값은 false로 본다.
   */
  readonly login_supported?: boolean;
};

export type UsageSummaryNode = {
  readonly nodeId: string;
  readonly fetchedAt: string | null;
  readonly stale: boolean;
  readonly staleSince: string | null;
  readonly providers: Readonly<Record<UsageSummaryProviderName, UsageSummaryProvider | null>>;
};

export type UsageSummarySnapshot = {
  readonly generatedAt: string;
  readonly collectedAt: string | null;
  readonly nodes: readonly UsageSummaryNode[];
};

export type UsageSummaryRequestOutcome = "idle" | "success" | "serverPending" | "connectionError";
export type UsageSummaryLoadState = "idle" | "ready" | "serverPending" | "connectionError";
export type UsageSummaryState = {
  scopeKey: string;
  lastSuccess: UsageSummarySnapshot | null;
  hideSummary: boolean;
  outcome: UsageSummaryRequestOutcome;
  loading: boolean;
  evaluatedAtMs: number;
};

type UsageSummaryOutcome =
  | { scopeKey: string; outcome: "success"; status: null; summary: UsageSummarySnapshot }
  | { scopeKey: string; outcome: "error"; status: number | null; summary: null };

export function applyUsageSummaryOutcome(
  prev: UsageSummaryState,
  result: UsageSummaryOutcome,
): UsageSummaryState {
  const scoped: UsageSummaryState = prev.scopeKey === result.scopeKey ? prev : {
    scopeKey: result.scopeKey,
    lastSuccess: null,
    hideSummary: false,
    outcome: "idle",
    loading: false,
    evaluatedAtMs: 0,
  };
  if (result.outcome === "success") {
    return { ...scoped, lastSuccess: result.summary, hideSummary: false, outcome: "success", loading: false };
  }
  if (result.status === 401) {
    return { ...scoped, lastSuccess: null, hideSummary: false, outcome: "idle", loading: false };
  }
  if (result.status === 404) {
    return { ...scoped, hideSummary: true, outcome: "serverPending", loading: false };
  }
  return { ...scoped, hideSummary: false, outcome: "connectionError", loading: false };
}

export function usageSummaryLoadState(outcome: UsageSummaryRequestOutcome, hasNode: boolean): UsageSummaryLoadState {
  if (outcome === "success") return hasNode ? "ready" : "serverPending";
  return outcome;
}

export type UsageSummaryGauge = {
  readonly id: "claude" | "fable" | "codex" | "antigravity";
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetAt: number | null;
};

export function findUsageSummaryNode(
  summary: UsageSummarySnapshot | null,
  nodeId: string | null,
): UsageSummaryNode | null {
  if (!summary || nodeId === null) return null;
  return summary.nodes.find((node) => node.nodeId === nodeId) ?? null;
}

export function selectUsageSummaryNode(
  summary: UsageSummarySnapshot | null,
  preferredNodeId: string | null,
  selectedNodeId: string | null,
): UsageSummaryNode | null {
  return findUsageSummaryNode(summary, selectedNodeId)
    ?? findUsageSummaryNode(summary, preferredNodeId)
    ?? summary?.nodes[0]
    ?? null;
}

export function nextUsageSummaryNodeId(
  summary: UsageSummarySnapshot | null,
  currentNodeId: string | null,
): string | null {
  if (!summary || summary.nodes.length === 0) return null;

  const currentIndex = summary.nodes.findIndex((node) => node.nodeId === currentNodeId);
  const startIndex = currentIndex < 0 ? 0 : currentIndex;
  return summary.nodes[(startIndex + 1) % summary.nodes.length].nodeId;
}

export function findFableWeeklyQuota(
  quotas: readonly UsageSummaryQuota[],
): UsageSummaryQuota | null {
  return quotas.find((quota) => {
    const identity = [quota.id, quota.label, quota.model ?? ""].join(" ").toLowerCase();
    return quota.window === "7d"
      && quota.id.startsWith("claude:weekly_scoped:")
      && identity.includes("fable");
  }) ?? null;
}

export function weeklyUsageGauges(node: UsageSummaryNode | null): UsageSummaryGauge[] {
  if (!node) return [];

  const gauges: UsageSummaryGauge[] = [];
  const claude = node.providers.claude;
  if (claude?.weeklyRemainingPercent !== null && claude?.weeklyRemainingPercent !== undefined) {
    gauges.push({
      id: "claude",
      label: "Claude",
      remainingPercent: claude.weeklyRemainingPercent,
      resetAt: claude.weeklyResetAt,
    });
  }

  const fableQuota = claude ? findFableWeeklyQuota(claude.quotas) : null;
  if (fableQuota?.remainingPercent !== null && fableQuota?.remainingPercent !== undefined) {
    gauges.push({
      id: "fable",
      label: fableQuota.model ?? fableQuota.label,
      remainingPercent: fableQuota.remainingPercent,
      resetAt: fableQuota.resetAt,
    });
  }

  const codex = node.providers.codex;
  if (codex?.weeklyRemainingPercent !== null && codex?.weeklyRemainingPercent !== undefined) {
    gauges.push({
      id: "codex",
      label: "Codex",
      remainingPercent: codex.weeklyRemainingPercent,
      resetAt: codex.weeklyResetAt,
    });
  }

  const antigravity = node.providers.antigravity;
  if (antigravity?.weeklyRemainingPercent !== null && antigravity?.weeklyRemainingPercent !== undefined) {
    gauges.push({
      id: "antigravity",
      label: "Antigravity",
      remainingPercent: antigravity.weeklyRemainingPercent,
      resetAt: antigravity.weeklyResetAt,
    });
  }

  return gauges;
}

export type ProviderQuotaSlotKind = "short" | "weekly" | "monthly" | "fable";

export type ProviderQuotaSlot = {
  readonly kind: ProviderQuotaSlotKind;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetAt: number | null;
  /** 7일 창이면 바를 7칸으로 나누고 지난 자리 커서를 그린다. 5시간과 월간은 아니다(카드 #1510). */
  readonly sevenDay: boolean;
};

export type ProviderQuotaSlots = readonly [
  ProviderQuotaSlot | null,
  ProviderQuotaSlot | null,
  ProviderQuotaSlot | null,
];

export function providerQuotaSlots(provider: UsageSummaryProvider | null): ProviderQuotaSlots {
  if (provider === null || provider.status !== "auto") return [null, null, null];

  const quotas = provider.quotas.filter(isExecutionQuota);
  const short = quotas.find((quota) => quota.model === null && quotaWindow(quota) === "5h") ?? null;
  const weekly = quotas.find((quota) =>
    quota.model === null
    && (quotaWindow(quota) === "7d" || quotaWindow(quota) === "168h")) ?? null;
  const monthly = quotas.find((quota) => quotaWindow(quota) === "monthly") ?? null;
  const fable = monthly === null ? findFableWeeklyQuota(quotas) : null;
  const fableRemaining = fable?.remainingPercent ?? null;
  const thirdSlot = monthly !== null
    ? quotaSlot("monthly", "월간", monthly)
    : fable === null || fableRemaining === null
      ? null
      : quotaSlot("fable", "Fable", { remainingPercent: fableRemaining, resetAt: fable.resetAt });

  return [
    short === null ? null : quotaSlot("short", "5시간", short),
    weekly === null ? null : quotaSlot("weekly", "7일", weekly),
    thirdSlot,
  ];
}

function isExecutionQuota(
  quota: UsageSummaryQuota,
): quota is UsageSummaryQuota & { readonly remainingPercent: number } {
  return quota.remainingPercent !== null
    && (quota.purpose === undefined || quota.purpose === "execution");
}

function quotaWindow(quota: UsageSummaryQuota): string | null {
  return quota.window === null ? null : quota.window.trim().toLowerCase();
}

function quotaSlot(
  kind: ProviderQuotaSlotKind,
  label: string,
  quota: { readonly remainingPercent: number; readonly resetAt: number | null },
): ProviderQuotaSlot {
  return {
    kind,
    label,
    usedPercent: Math.min(100, Math.max(0, 100 - quota.remainingPercent)),
    resetAt: quota.resetAt,
    // 7일 창을 weekly 칸이 받고(7d·168h), Fable 스코프 창도 7일이다.
    sevenDay: kind === "weekly" || kind === "fable",
  };
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 7일 창에서 지금까지 지난 비율(0~1). 칸막이는 늘 k/7에 서고,
 * 이 값이 커서의 가로 자리를 정한다. 리셋 시각이 없거나 이미 지났으면 null(커서 없음).
 * 카드 #1510: 웹과 앱이 같은 함수로 잰다.
 */
export function sevenDayElapsedFraction(
  resetAtEpochSeconds: number | null,
  nowMs: number,
): number | null {
  if (resetAtEpochSeconds === null || !Number.isFinite(resetAtEpochSeconds)) return null;
  const remainingMs = resetAtEpochSeconds * 1000 - nowMs;
  if (remainingMs <= 0) return null;
  return Math.min(1, Math.max(0, 1 - remainingMs / SEVEN_DAY_MS));
}

export function weeklyUsedPercent(remaining: number | null): number | null {
  return remaining === null ? null : Math.min(100, Math.max(0, 100 - remaining));
}

export function formatWeeklyUsedPercent(value: number): string {
  const wholePercent = value < 0 ? Math.ceil(value - 0.5) : Math.floor(value + 0.5);
  return `${wholePercent}%`;
}

export function formatUsageResetCountdown(
  resetAtEpochSeconds: number | null,
  nowMs: number,
  compact: boolean,
): string | null {
  if (resetAtEpochSeconds === null) return null;

  const secondsRemaining = Math.max(0, Math.trunc(resetAtEpochSeconds - nowMs / 1000));
  const secondsPerDay = 24 * 60 * 60;
  const secondsPerHour = 60 * 60;
  if (secondsRemaining >= secondsPerDay) {
    const days = Math.floor(secondsRemaining / secondsPerDay);
    if (compact) return `${days}일`;
    const hours = Math.floor((secondsRemaining % secondsPerDay) / secondsPerHour);
    return `${days}일 ${hours}시간`;
  }
  if (secondsRemaining >= secondsPerHour) {
    return `${Math.floor(secondsRemaining / secondsPerHour)}시간`;
  }
  return `${Math.floor(secondsRemaining / 60)}분`;
}

export function formatUsageUpdatedLabel(fetchedAt: string | null, stale: boolean): string {
  if (!fetchedAt) return "갱신 대기 중";
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) return "갱신 대기 중";

  const date = new Date(timestamp);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const updated = `${month}/${day} ${hour}:${minute} 갱신`;
  return stale ? `마지막 ${updated}` : updated;
}
