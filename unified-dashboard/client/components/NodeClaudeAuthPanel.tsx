import { useState, useEffect, useCallback } from "react";
import { Button } from "@seosoyoung/soul-ui";

interface Props {
  nodeId: string;
}

export function NodeClaudeAuthPanel({ nodeId }: Props) {
  const [status, setStatus] = useState<{ has_token: boolean } | null>(null);
  const [usage, setUsage] = useState<unknown>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const handleLogin = () => {
    window.location.href = `/api/nodes/${nodeId}/claude-auth/start`;
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
          {usage && (
            <pre className="text-xs bg-background p-1.5 rounded overflow-auto max-h-24">
              {JSON.stringify(usage, null, 2)}
            </pre>
          )}
          {error && <div className="text-xs text-accent-red">{error}</div>}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
          <span className="text-xs text-muted-foreground">미인증</span>
          <Button size="sm" onClick={handleLogin}>
            로그인
          </Button>
        </div>
      )}
    </div>
  );
}
