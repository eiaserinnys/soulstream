import { useState, useEffect, useCallback } from "react";
import { Button } from "@seosoyoung/soul-ui";

interface TokenStatus {
  has_token: boolean;
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

export function ClaudeAuthTab() {
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [usage, setUsage] = useState<unknown>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [codeValue, setCodeValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  const handleLogin = async () => {
    setError(null);
    try {
      const res = await fetch("/auth/claude/headless/start");
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(
          data?.detail
            ? parseErrorDetail(data.detail)
            : "인증 URL을 가져오는 중 오류가 발생했습니다."
        );
      }
      const data = await res.json();
      if (!data.authUrl) throw new Error("authUrl 없음");
      window.open(data.authUrl, "_blank");
      setShowCodeInput(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const handleSubmitCode = async () => {
    const trimmed = codeValue.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/auth/claude/headless/submit-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
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
    setShowCodeInput(false);
    setCodeValue("");
    setError(null);
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
          {showCodeInput && (
            <div className="mt-2 space-y-1.5">
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
          {showCodeInput && (
            <div className="mt-2 space-y-1.5">
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
