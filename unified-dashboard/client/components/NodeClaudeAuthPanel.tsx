import { useCallback, useState } from "react";
import { Button, cn } from "@seosoyoung/soul-ui";
import { useClaudeAuthFlow } from "../hooks/useClaudeAuthFlow";

interface Props {
  nodeId: string;
}

type ProviderName = "claude" | "codex" | "gemini";

type ProviderQuota = {
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

type ProviderLimits = {
  status: "auto" | "not_configured" | "error";
  source: string;
  planType: string | null;
  quotas: ProviderQuota[];
  error?: string;
};

type ProviderUsageSnapshot = {
  generatedAt: string;
  providers: Record<ProviderName, ProviderLimits>;
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

function formatResetsAt(epochSeconds: number | null): string | null {
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

function ProviderUsageChart({ usage }: { usage: ProviderUsageSnapshot }) {
  const providers = Object.entries(usage.providers) as [ProviderName, ProviderLimits][];

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

type AccountProfile = {
  email: string;
  display_name: string;
  has_claude_max: boolean;
};

export function NodeClaudeAuthPanel({ nodeId }: Props) {
  const basePath = `/api/nodes/${nodeId}/claude-auth`;
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [providerUsage, setProviderUsage] = useState<ProviderUsageSnapshot | null>(null);
  const [loadingProviderUsage, setLoadingProviderUsage] = useState(false);
  const [providerUsageError, setProviderUsageError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/profile`);
      if (res.ok) {
        const data = await res.json();
        setProfile(data.account ?? null);
      }
    } catch {
      // 프로필 조회 실패는 무시 — 인증 상태 표시에는 영향 없음
    }
  }, [basePath]);

  const flow = useClaudeAuthFlow<unknown>({
    basePath,
    statusPath: "/status",
    onAuthenticated: fetchProfile,
    onTokenDeleted: () => {
      setProfile(null);
      setProviderUsage(null);
    },
  });

  const fetchProviderUsage = useCallback(async () => {
    setLoadingProviderUsage(true);
    setProviderUsageError(null);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/provider-usage`);
      if (!res.ok) {
        throw new Error((await res.text()) || `HTTP ${res.status}`);
      }
      setProviderUsage((await res.json()) as ProviderUsageSnapshot);
    } catch (err) {
      setProviderUsageError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingProviderUsage(false);
    }
  }, [nodeId]);

  const codeInput = flow.showCodeInput && (
    <div className="mt-2 space-y-1.5">
      {flow.authUrl && (
        <a
          href={flow.authUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary underline"
        >
          Anthropic 인증 페이지 열기 →
        </a>
      )}
      <div className="text-xs text-muted-foreground">
        Anthropic 페이지에 표시된 코드를 붙여넣으세요.
      </div>
      <textarea
        className="w-full text-xs font-mono p-1.5 border border-border rounded resize-none bg-background"
        rows={2}
        placeholder="YSrAXqZq...#7RVDts..."
        value={flow.codeValue}
        onChange={(e) => flow.setCodeValue(e.target.value)}
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          onClick={flow.handleSubmitCode}
          disabled={flow.submitting}
        >
          {flow.submitting ? "..." : "확인"}
        </Button>
        <Button size="sm" variant="outline" onClick={flow.handleCancelCode}>
          취소
        </Button>
      </div>
    </div>
  );

  return (
    <div className="px-3 py-2 border-t border-border bg-muted/20 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Claude Code 크레덴셜
      </div>
      {flow.loadingStatus ? (
        <div className="text-xs text-muted-foreground">확인 중...</div>
      ) : flow.tokenStatus?.has_token ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-success" />
            <span className="text-xs">인증됨</span>
            {profile && (
              <span className="text-xs text-muted-foreground truncate">
                {profile.email}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchProviderUsage}
              disabled={loadingProviderUsage}
            >
              {loadingProviderUsage ? "..." : "사용량"}
            </Button>
            <Button size="sm" variant="outline" onClick={flow.handleLogin}>
              재로그인
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={flow.handleDeleteToken}
            >
              삭제
            </Button>
          </div>
          {codeInput}
          {providerUsage && <ProviderUsageChart usage={providerUsage} />}
          {providerUsageError && (
            <div className="text-xs text-accent-red">{providerUsageError}</div>
          )}
          {flow.error && (
            <div className="text-xs text-accent-red">{flow.error}</div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
            <span className="text-xs text-muted-foreground">미인증</span>
            <Button size="sm" onClick={flow.handleLogin}>
              로그인
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchProviderUsage}
              disabled={loadingProviderUsage}
            >
              {loadingProviderUsage ? "..." : "사용량"}
            </Button>
          </div>
          {codeInput}
          {providerUsage && <ProviderUsageChart usage={providerUsage} />}
          {providerUsageError && (
            <div className="text-xs text-accent-red">{providerUsageError}</div>
          )}
          {flow.error && (
            <div className="text-xs text-accent-red">{flow.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
