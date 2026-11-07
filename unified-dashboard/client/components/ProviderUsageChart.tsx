import { cn } from "@seosoyoung/soul-ui";

export type ProviderName = "claude" | "codex" | "antigravity" | "opencode_go";

export type ProviderQuota = {
  id: string;
  label: string;
  window: string | null;
  unit: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  model: string | null;
  source: string | null;
};

export type ProviderLimits = {
  status: "auto" | "not_configured" | "error";
  source: string;
  planType: string | null;
  quotas: ProviderQuota[];
  error?: string;
};

export type ProviderUsageSnapshot = {
  generatedAt: string;
  providers: Record<ProviderName, ProviderLimits>;
};

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode_go: "OpenCode Go",
};

export function formatResetsAt(epochSeconds: number | null): string | null {
  if (!epochSeconds) return null;
  const d = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  return d.toLocaleString(undefined, opts);
}

function getBarColor(utilization: number): string {
  if (utilization >= 80) return "bg-accent-red";
  if (utilization >= 50) return "bg-accent-amber";
  return "bg-success";
}

function formatQuotaAmount(quota: ProviderQuota): string | null {
  if (quota.remaining !== null && quota.limit !== null) {
    return `${quota.remaining.toLocaleString()} / ${quota.limit.toLocaleString()} 남음`;
  }
  if (quota.used !== null && quota.limit !== null) {
    return `${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} 사용`;
  }
  return null;
}

export function ProviderUsageChart({
  usage,
  providers: visibleProviders,
}: {
  usage: ProviderUsageSnapshot;
  providers?: readonly ProviderName[];
}) {
  const providers = Object.entries(usage.providers)
    .filter(([provider]) => provider !== "gemini" && (!visibleProviders || visibleProviders.includes(provider as ProviderName))) as [ProviderName, ProviderLimits][];

  if (providers.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">사용량 데이터 없음</div>
    );
  }

  return (
    <div className="space-y-3">
      {providers.map(([provider, limits]) => (
        <div key={provider} className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">{PROVIDER_LABELS[provider]}</span>
            <span className="text-muted-foreground">
              {limits.status === "error"
                ? "오류"
                : limits.quotas.length > 0
                  ? limits.planType ?? "OAuth"
                  : provider === "opencode_go" && limits.status === "not_configured"
                    ? "키 없음"
                    : "OAuth 없음"}
            </span>
          </div>
          {limits.quotas.length === 0 ? (
            <div className="text-xs text-muted-foreground/70">
              {limits.error ?? "조회 가능한 사용량 없음"}
            </div>
          ) : (
            <div className="space-y-2">
              {limits.quotas.map((quota) => {
                const used = quota.usedPercent ?? 0;
                const reset = formatResetsAt(quota.resetAt);
                const amount = formatQuotaAmount(quota);
                return (
                  <div key={quota.id} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-muted-foreground">
                        {quota.label}
                      </span>
                      <span className="tabular-nums">
                        {quota.usedPercent !== null
                          ? `${Math.round(quota.usedPercent)}%`
                          : amount ?? "-"}
                      </span>
                    </div>
                    {quota.usedPercent !== null && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn("h-full rounded-full", getBarColor(used))}
                          style={{ width: `${used}%` }}
                        />
                      </div>
                    )}
                    {(reset || amount) && (
                      <div className="text-xs text-muted-foreground/70">
                        {amount ? `${amount}${reset ? " · " : ""}` : ""}
                        {reset ? `초기화: ${reset}` : ""}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
