import { useCallback, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";
import { useClaudeAuthFlow } from "../hooks/useClaudeAuthFlow";
import { ProviderUsageChart, type ProviderUsageSnapshot } from "./ProviderUsageChart";

interface Props {
  request?: typeof fetch;
  nodeId: string;
}

type AccountProfile = {
  email: string;
  display_name: string;
  has_claude_max: boolean;
};

export function NodeClaudeAuthPanel({ nodeId, request = fetch }: Props) {
  const basePath = `/api/nodes/${nodeId}/claude-auth`;
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [providerUsage, setProviderUsage] = useState<ProviderUsageSnapshot | null>(null);
  const [loadingProviderUsage, setLoadingProviderUsage] = useState(false);
  const [providerUsageError, setProviderUsageError] = useState<string | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await request(`${basePath}/profile`);
      if (res.ok) {
        const data = await res.json();
        setProfile(data.account ?? null);
      }
    } catch {
      // 프로필 조회 실패는 무시 — 인증 상태 표시에는 영향 없음
    }
  }, [basePath]);

  const flow = useClaudeAuthFlow<unknown>({
    request,
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
      const res = await request(`/api/nodes/${nodeId}/provider-usage`);
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
