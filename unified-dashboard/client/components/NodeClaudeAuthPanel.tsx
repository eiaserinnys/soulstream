import { useState, useEffect, useCallback, useRef } from "react";
import { Button, cn } from "@seosoyoung/soul-ui";

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
      key !== "extra_usage" && value !== null && (value as BucketUsage).utilization !== null
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
              className={cn("h-full rounded-full", getBarColor(bucket.utilization))}
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

const errorMessages: Record<string, string> = {
  missing_code: "코드를 입력해주세요.",
  invalid_code_format:
    "코드 형식이 올바르지 않습니다. (#이 포함된 코드를 붙여넣으세요)",
  invalid_state: "인증 요청이 만료되었습니다. 다시 시도해주세요.",
};

const parseErrorDetail = (detail: string): string => {
  if (errorMessages[detail]) return errorMessages[detail];
  if (detail.startsWith("token_exchange_failed"))
    return "토큰 교환 중 오류가 발생했습니다.";
  if (detail.includes("not connected"))
    return "노드가 연결되지 않았습니다. 연결 상태를 확인해주세요.";
  return detail || "오류가 발생했습니다.";
};

export function NodeClaudeAuthPanel({ nodeId }: Props) {
  const [status, setStatus] = useState<{ has_token: boolean } | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [codeValue, setCodeValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // popup은 useRef로 관리하여 handleCancelCode에서도 닫을 수 있게 한다.
  const popupRef = useRef<Window | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/claude-auth/status`);
      setStatus(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingStatus(false);
    }
  }, [nodeId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleLogin = async () => {
    setError(null);
    // 팝업 차단 우회: 버튼 클릭 직후 동기 컨텍스트에서 빈 탭을 먼저 열고,
    // fetch 완료 후 authUrl로 navigate한다.
    // iOS Safari는 async 호출 후 window.open()을 차단하지만 동기 호출은 허용한다.
    popupRef.current = window.open('about:blank', '_blank');
    try {
      const res = await fetch(
        `/api/nodes/${nodeId}/claude-auth/headless/start`
      );
      if (!res.ok) {
        popupRef.current?.close();
        popupRef.current = null;
        const data = await res.json().catch(() => null);
        throw new Error(
          data?.detail
            ? parseErrorDetail(data.detail)
            : "인증 URL을 가져오는 중 오류가 발생했습니다."
        );
      }
      const data = await res.json();
      if (!data.authUrl) {
        popupRef.current?.close();
        popupRef.current = null;
        throw new Error("authUrl 없음");
      }
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.location.href = data.authUrl; // 팝업이 열렸으면 직접 navigate
      } else {
        setAuthUrl(data.authUrl); // 차단된 경우 <a> 링크 fallback
      }
      setShowCodeInput(true);
    } catch (e) {
      popupRef.current?.close();
      popupRef.current = null;
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const handleSubmitCode = async () => {
    const trimmed = codeValue.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/nodes/${nodeId}/claude-auth/headless/submit-code`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(parseErrorDetail(data?.detail ?? ""));
        return;
      }
      setShowCodeInput(false);
      setCodeValue("");
      fetchStatus();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelCode = () => {
    popupRef.current?.close();
    popupRef.current = null;
    setShowCodeInput(false);
    setAuthUrl(null);
    setCodeValue("");
    setError(null);
  };

  const handleDeleteToken = async () => {
    await fetch(`/api/nodes/${nodeId}/claude-auth/token`, { method: "DELETE" });
    setStatus({ has_token: false });
    setUsage(null);
  };

  const fetchUsage = async () => {
    setLoadingUsage(true);
    setError(null);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/claude-auth/usage`);
      if (!res.ok) throw new Error(await res.text());
      setUsage(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingUsage(false);
    }
  };

  return (
    <div className="px-3 py-2 border-t border-border bg-muted/20 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Claude Code 크레덴셜
      </div>
      {loadingStatus ? (
        <div className="text-xs text-muted-foreground">확인 중...</div>
      ) : status?.has_token ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-success" />
            <span className="text-xs">인증됨</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchUsage}
              disabled={loadingUsage}
            >
              {loadingUsage ? "..." : "사용량"}
            </Button>
            <Button size="sm" variant="outline" onClick={handleLogin}>
              재로그인
            </Button>
            <Button size="sm" variant="destructive" onClick={handleDeleteToken}>
              삭제
            </Button>
          </div>
          {showCodeInput && (
            <div className="mt-2 space-y-1.5">
              {authUrl && (
                <a
                  href={authUrl}
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
                value={codeValue}
                onChange={(e) => setCodeValue(e.target.value)}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  onClick={handleSubmitCode}
                  disabled={submitting}
                >
                  {submitting ? "..." : "확인"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelCode}
                >
                  취소
                </Button>
              </div>
            </div>
          )}
          {usage && <UsageBarChart usage={usage} />}
          {error && <div className="text-xs text-accent-red">{error}</div>}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
            <span className="text-xs text-muted-foreground">미인증</span>
            <Button size="sm" onClick={handleLogin}>
              로그인
            </Button>
          </div>
          {showCodeInput && (
            <div className="mt-2 space-y-1.5">
              {authUrl && (
                <a
                  href={authUrl}
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
                value={codeValue}
                onChange={(e) => setCodeValue(e.target.value)}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  onClick={handleSubmitCode}
                  disabled={submitting}
                >
                  {submitting ? "..." : "확인"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelCode}
                >
                  취소
                </Button>
              </div>
            </div>
          )}
          {error && <div className="text-xs text-accent-red">{error}</div>}
        </div>
      )}
    </div>
  );
}
