import { Button } from "@seosoyoung/soul-ui";
import { useClaudeAuthFlow } from "../hooks/useClaudeAuthFlow";

export function ClaudeAuthTab() {
  const flow = useClaudeAuthFlow({ basePath: "/auth/claude" });

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
    <div className="space-y-4">
      <div className="text-sm font-medium">Claude Code 인증 상태</div>
      {flow.loadingStatus ? (
        <div className="text-xs text-muted-foreground">확인 중...</div>
      ) : flow.tokenStatus?.has_token ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success" />
            <span className="text-xs text-foreground">인증됨</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={flow.fetchUsage}
              disabled={flow.loadingUsage}
            >
              {flow.loadingUsage ? "조회 중..." : "사용량 확인"}
            </Button>
            <Button size="sm" variant="outline" onClick={flow.handleLogin}>
              재로그인
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={flow.handleDeleteToken}
            >
              토큰 삭제
            </Button>
          </div>
          {codeInput}
          {flow.usage != null && (
            <pre className="text-xs bg-muted p-2 rounded overflow-auto max-h-32">
              {JSON.stringify(flow.usage, null, 2)}
            </pre>
          )}
          {flow.error && (
            <div className="text-xs text-accent-red">{flow.error}</div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
            <span className="text-xs text-muted-foreground">미인증</span>
          </div>
          <Button size="sm" onClick={flow.handleLogin}>
            Claude Code 로그인
          </Button>
          {codeInput}
          {flow.error && (
            <div className="text-xs text-accent-red">{flow.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
