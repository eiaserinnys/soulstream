import { useEffect, useRef, useState } from "react";
import { Button, DashboardIconCap, Input } from "@seosoyoung/soul-ui";
import { AlertCircle, ExternalLink, Loader2, RotateCcw, X } from "lucide-react";
import type { ClaudeAccount, ClaudeAuthLoginFlow } from "@seosoyoung/soul-ui";
import {
  claudeAuthErrorMessage,
  loginPath,
  requestClaudeAuthData,
  requestErrorMessage,
} from "../../lib/claude-auth-api";

type Props = {
  nodeId: string;
  request: typeof fetch;
  account: ClaudeAccount | null;
  isAdditionalAccount: boolean;
  initialFlow: ClaudeAuthLoginFlow;
  onClose: () => void;
  onComplete: () => Promise<void>;
  onExistingAccount: (accountId: string) => void;
  onRestart: () => Promise<ClaudeAuthLoginFlow>;
};

function isPolling(flow: ClaudeAuthLoginFlow): boolean {
  return flow.state === "requested" || flow.state === "code_submitted" || flow.state === "verifying";
}

function stateLabel(state: ClaudeAuthLoginFlow["state"]): string {
  if (state === "requested") return "인증 주소 준비 중";
  if (state === "url_ready") return "코드 입력 대기";
  if (state === "code_submitted" || state === "verifying") return "확인 중";
  if (state === "done") return "연결 완료";
  if (state === "failed") return "오류";
  return "취소됨";
}

export function ClaudeAuthLoginSheet({
  nodeId,
  request,
  account,
  isAdditionalAccount,
  initialFlow,
  onClose,
  onComplete,
  onExistingAccount,
  onRestart,
}: Props) {
  const [flow, setFlow] = useState(initialFlow);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!isPolling(flow)) return;
    let active = true;
    const timer = globalThis.setTimeout(() => {
      void requestClaudeAuthData<ClaudeAuthLoginFlow>(request, loginPath(nodeId, flow.login_id))
        .then(async (next) => {
          if (!active) return;
          setFlow(next);
          setActionError(null);
          if (next.error?.existing_account_id) onExistingAccount(next.error.existing_account_id);
          if (next.state === "done") await onComplete();
        })
        .catch((error: unknown) => {
          if (active) {
            setActionError(requestErrorMessage(error));
            setFlow((current) => ({ ...current }));
          }
        });
    }, 1000);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [flow, isAdditionalAccount, nodeId, onComplete, onExistingAccount, request]);

  async function submitCode() {
    if (inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setSubmitting(true);
    setActionError(null);
    const submittedCode = code.trim();
    setCode("");
    try {
      const next = await requestClaudeAuthData<ClaudeAuthLoginFlow>(
        request,
        `${loginPath(nodeId, flow.login_id)}/code`,
        { method: "POST", body: { code: submittedCode } },
      );
      setFlow(next);
      if (next.error?.existing_account_id) onExistingAccount(next.error.existing_account_id);
      if (next.state === "done") await onComplete();
    } catch (error) {
      setActionError(requestErrorMessage(error));
      if (error instanceof Error && "apiError" in error) {
        const apiError = (error as { apiError?: { existing_account_id?: string } }).apiError;
        if (apiError?.existing_account_id) onExistingAccount(apiError.existing_account_id);
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setActionError(null);
    try {
      await requestClaudeAuthData<ClaudeAuthLoginFlow>(request, loginPath(nodeId, flow.login_id), { method: "DELETE" });
      onClose();
    } catch (error) {
      setActionError(requestErrorMessage(error));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function restart() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setActionError(null);
    setCode("");
    try {
      setFlow(await onRestart());
    } catch (error) {
      setActionError(requestErrorMessage(error));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const visibleError = actionError ?? (flow.state === "failed" ? claudeAuthErrorMessage(flow.error) : null);
  const title = account ? `계정 재로그인 (${account.email})` : "새 Claude 계정 연결";
  const hint = flow.state === "requested"
    ? "인증 주소를 준비하고 있습니다."
    : flow.state === "url_ready" && isAdditionalAccount
      ? "두 번째 계정부터는 시크릿 창이나 별도 브라우저 프로필에서 승인하세요."
    : flow.state === "code_submitted" || flow.state === "verifying"
      ? "인증 코드를 확인하고 계정 정보를 가져오는 중입니다."
      : flow.state === "done"
        ? "계정 목록에 반영했습니다."
        : "인증 페이지에서 코드를 받은 뒤 붙여넣으세요.";

  return <section className="c724-auth-sheet" data-testid="claude-login-sheet" data-login-state={flow.state}>
    <div className="c724-auth-sheet-header">
      <span className="c724-auth-sheet-title">{title}</span>
      <DashboardIconCap size="small" label="로그인 닫기" disabled={submitting} onClick={() => void cancel()}>
        <X className="size-4" aria-hidden="true" />
      </DashboardIconCap>
    </div>
    <div className="c724-login-state-row">
      <span className={`c724-badge ${flow.state === "failed" ? "c724-badge-danger" : flow.state === "done" ? "c724-badge-accent" : "c724-badge-neutral"}`} role="status">
        {flow.state === "verifying" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
        {stateLabel(flow.state)}
      </span>
      <p className="c724-auth-hint">{hint}</p>
    </div>
    {flow.state === "url_ready" && flow.auth_url ? <Button variant="outline" size="sm" render={<a href={flow.auth_url} target="_blank" rel="noopener noreferrer" />}>
      <ExternalLink className="size-4" aria-hidden="true" /> 인증 페이지 열기
    </Button> : null}
    {visibleError ? <div className="c724-login-error" role="alert">
      <AlertCircle className="size-4" aria-hidden="true" />
      <span>{visibleError}</span>
    </div> : null}
    {flow.state === "url_ready" || flow.state === "failed" ? <div className="c724-auth-code-row">
      <Input
        aria-label="Claude 인증 코드"
        autoComplete="off"
        className="flex-1"
        disabled={submitting}
        placeholder="인증 코드 붙여넣기 (code#state)"
        value={code}
        onChange={(event) => setCode(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void submitCode(); }}
      />
      <Button variant="default" size="sm" disabled={submitting || !code.trim()} onClick={() => void submitCode()}>
        {submitting ? "확인 중" : flow.state === "failed" ? "다시 확인" : "확인"}
      </Button>
    </div> : null}
    {flow.state === "failed" ? <div className="c724-login-actions">
      <Button variant="outline" size="sm" disabled={submitting} onClick={() => void restart()}>
        <RotateCcw className="size-4" aria-hidden="true" /> 새 인증 링크 받기
      </Button>
      {flow.auth_url ? <Button variant="outline" size="sm" render={<a href={flow.auth_url} target="_blank" rel="noopener noreferrer" />}>
        <ExternalLink className="size-4" aria-hidden="true" /> 인증 페이지 열기
      </Button> : null}
    </div> : null}
    {flow.state === "done" ? <div className="c724-login-actions">
      <Button variant="outline" size="sm" onClick={onClose}>닫기</Button>
    </div> : null}
  </section>;
}
