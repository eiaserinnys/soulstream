import { useCallback, useState } from "react";
import { Button, cn } from "@seosoyoung/soul-ui";
import { useClaudeAuthFlow } from "../hooks/useClaudeAuthFlow";

interface Props {
  nodeId: string;
}

type BucketUsage = {
  utilization: number;
  resets_at: string;
};

type UsageData = {
  five_hour: BucketUsage | null;
  seven_day: BucketUsage | null;
  seven_day_sonnet: BucketUsage | null;
  seven_day_opus: BucketUsage | null;
  seven_day_oauth_apps: BucketUsage | null;
  seven_day_cowork: BucketUsage | null;
  iguana_necktie: BucketUsage | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
};

const BUCKET_LABELS: Record<string, string> = {
  five_hour: "5시간",
  seven_day: "7일",
  seven_day_sonnet: "7일 (Sonnet)",
  seven_day_opus: "7일 (Opus)",
  seven_day_oauth_apps: "7일 (OAuth Apps)",
  seven_day_cowork: "7일 (협업)",
  iguana_necktie: "기타",
};

function formatResetsAt(isoStr: string): string {
  const d = new Date(isoStr);
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

function UsageBarChart({ usage }: { usage: UsageData }) {
  const entries = (
    Object.entries(usage) as [keyof UsageData, UsageData[keyof UsageData]][]
  ).filter(
    ([key, value]) =>
      key !== "extra_usage" &&
      value !== null &&
      (value as BucketUsage).utilization !== null,
  ) as [string, BucketUsage][];

  if (entries.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">사용량 데이터 없음</div>
    );
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, bucket]) => (
        <div key={key} className="space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {BUCKET_LABELS[key] ?? key}
            </span>
            <span className="tabular-nums">{bucket.utilization}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full",
                getBarColor(bucket.utilization),
              )}
              style={{ width: `${bucket.utilization}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground/70">
            초기화: {formatResetsAt(bucket.resets_at)}
          </div>
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

  const flow = useClaudeAuthFlow<UsageData>({
    basePath,
    statusPath: "/status",
    onAuthenticated: fetchProfile,
    onTokenDeleted: () => setProfile(null),
  });

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
              onClick={flow.fetchUsage}
              disabled={flow.loadingUsage}
            >
              {flow.loadingUsage ? "..." : "사용량"}
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
          {flow.usage && <UsageBarChart usage={flow.usage} />}
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
          </div>
          {codeInput}
          {flow.error && (
            <div className="text-xs text-accent-red">{flow.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
