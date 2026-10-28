export const USAGE_SUMMARY_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export type UsageSummaryProviderName = "claude" | "codex" | "antigravity";

export type ClaudeAccountUsageWindow = {
  readonly used_percent: number;
  readonly resets_at: string | null;
};

export type ClaudeAccountBlocked = {
  readonly until: string | null;
  readonly scope: "all" | "fable";
};

export type ClaudeAccount = {
  readonly id: string;
  readonly email: string;
  readonly plan: string | null;
  readonly enabled: boolean;
  readonly priority: number | null;
  readonly auth_state: "ok" | "idle" | "needs_relogin" | "logging_in";
  readonly usage: {
    readonly five_hour: ClaudeAccountUsageWindow | null;
    readonly seven_day: ClaudeAccountUsageWindow | null;
    readonly fable_weekly: ClaudeAccountUsageWindow | null;
  };
  readonly observed_at: string | null;
  readonly blocked: ClaudeAccountBlocked | null;
  readonly active_sessions: number;
};

export type ClaudeAccountPool = {
  readonly available_count: number;
  readonly total_count: number;
  readonly best_weekly_remaining_percent: number | null;
  readonly best_weekly_resets_at: string | null;
  readonly earliest_available_at: string | null;
};

export type ClaudeAccountList = {
  readonly mode: "legacy" | "pool";
  readonly accounts: readonly ClaudeAccount[];
  readonly pool: ClaudeAccountPool | null;
  readonly fable_pool: ClaudeAccountPool | null;
};

export type ClaudeAccountDeleteResult = {
  readonly deferred: boolean;
  readonly accounts: readonly ClaudeAccount[];
  readonly pool: ClaudeAccountPool | null;
};

export type ClaudeAuthError = {
  readonly code: string;
  readonly message: string;
  readonly existing_account_id?: string;
};

export type ClaudeAuthLoginFlow = {
  readonly login_id: string;
  readonly account_id: string | null;
  readonly state:
    | "requested"
    | "url_ready"
    | "code_submitted"
    | "verifying"
    | "done"
    | "failed"
    | "cancelled";
  readonly auth_url: string | null;
  readonly expires_at: string;
  readonly error: ClaudeAuthError | null;
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

  const fableQuota = claude?.quotas.find((quota) => {
    const identity = [quota.id, quota.label, quota.model ?? ""].join(" ").toLowerCase();
    return quota.window === "7d"
      && quota.id.startsWith("claude:weekly_scoped:")
      && identity.includes("fable");
  });
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

export function formatWeeklyRemainingPercent(value: number): string {
  const rounded = value < 0 ? Math.ceil(value - 0.5) : Math.floor(value + 0.5);
  return `${rounded}%`;
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
