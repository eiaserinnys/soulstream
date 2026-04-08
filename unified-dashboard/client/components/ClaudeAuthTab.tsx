import { useState, useEffect, useCallback } from "react";
import { Button } from "@seosoyoung/soul-ui";

interface TokenStatus {
  has_token: boolean;
}

export function ClaudeAuthTab() {
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [usage, setUsage] = useState<unknown>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/auth/claude/token");
      setTokenStatus(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const fetchUsage = useCallback(async () => {
    setLoadingUsage(true);
    setError(null);
    try {
      const res = await fetch("/auth/claude/usage");
      if (!res.ok) throw new Error(await res.text());
      setUsage(await res.json());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleLogin = () => {
    window.location.href = "/auth/claude/web/start";
  };

  const handleDeleteToken = async () => {
    await fetch("/auth/claude/token", { method: "DELETE" });
    setTokenStatus({ has_token: false });
    setUsage(null);
  };

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium">Claude Code 인증 상태</div>
      {loadingStatus ? (
        <div className="text-xs text-muted-foreground">확인 중...</div>
      ) : tokenStatus?.has_token ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success" />
            <span className="text-xs text-foreground">인증됨</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={fetchUsage}
              disabled={loadingUsage}
            >
              {loadingUsage ? "조회 중..." : "사용량 확인"}
            </Button>
            <Button size="sm" variant="outline" onClick={handleLogin}>
              재로그인
            </Button>
            <Button size="sm" variant="destructive" onClick={handleDeleteToken}>
              토큰 삭제
            </Button>
          </div>
          {usage && (
            <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-32">
              {JSON.stringify(usage, null, 2)}
            </pre>
          )}
          {error && <div className="text-xs text-accent-red">{error}</div>}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
            <span className="text-xs text-muted-foreground">미인증</span>
          </div>
          <Button size="sm" onClick={handleLogin}>
            Claude Code 로그인
          </Button>
        </div>
      )}
    </div>
  );
}
