import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import { AlertCircle, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import type { ClaudeAccount, ClaudeAuthLoginFlow } from "../../../../packages/wire-schema/generated/typescript/index";
import {
  cancelClaudeAccountLogin,
  claudeAuthErrorMessage,
  loginPath,
  requestClaudeAuthData,
  requestErrorMessage,
  type ClaudeAccountTarget,
} from "../../lib/claude-auth-api";

type Props = {
  target: ClaudeAccountTarget;
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

function isTerminalLoginState(state: ClaudeAuthLoginFlow["state"]): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

function stateLabel(state: ClaudeAuthLoginFlow["state"], t: ReturnType<typeof useTranslation>["t"]): string {
  if (state === "requested") return t("accounts.login.preparingLink");
  if (state === "code_submitted" || state === "verifying") return t("accounts.common.checking");
  if (state === "done") return t("accounts.login.connectionComplete");
  if (state === "failed") return t("accounts.common.error");
  return t("accounts.login.cancelledState");
}

export function ClaudeAuthLoginSheet({
  target,
  request,
  account,
  isAdditionalAccount,
  initialFlow,
  onClose,
  onComplete,
  onExistingAccount,
  onRestart,
}: Props) {
  const { t } = useTranslation();
  const [flow, setFlow] = useState(initialFlow);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const activeLogin = useRef({ loginId: initialFlow.login_id, shouldCancel: !isTerminalLoginState(initialFlow.state) });
  const lifecycle = useRef(0);
  const cancellationContext = useRef({ target, request });
  cancellationContext.current = { target, request };
  const isChecking = submitting || flow.state === "code_submitted" || flow.state === "verifying";

  const updateFlow = useCallback((next: ClaudeAuthLoginFlow) => {
    activeLogin.current = { loginId: next.login_id, shouldCancel: !isTerminalLoginState(next.state) };
    setFlow(next);
  }, []);

  useEffect(() => {
    const mountedLifecycle = ++lifecycle.current;
    return () => {
      void Promise.resolve().then(() => {
        if (lifecycle.current !== mountedLifecycle) return;
        const pending = activeLogin.current;
        if (!pending.shouldCancel) return;
        const current = cancellationContext.current;
        void cancelClaudeAccountLogin(current.request, current.target, pending.loginId).catch(() => {});
      });
    };
  }, []);

  // 시트를 열거나 코드가 틀려 되돌아오면 첫 입력인 인증 코드 칸으로 초점을 옮긴다(ui-design 0절 14번).
  useEffect(() => {
    if (flow.state === "url_ready" || flow.state === "failed") codeInputRef.current?.focus();
  }, [flow.state]);

  useEffect(() => {
    if (!isPolling(flow)) return;
    let active = true;
    const timer = globalThis.setTimeout(() => {
      void requestClaudeAuthData<ClaudeAuthLoginFlow>(request, loginPath(target, flow.login_id))
        .then(async (next) => {
          if (!active) return;
          updateFlow(next);
          setActionError(null);
          if (next.error?.existing_account_id) onExistingAccount(next.error.existing_account_id);
          if (next.state === "done") await onComplete();
        })
        .catch((error: unknown) => {
          if (active) {
            setActionError(requestErrorMessage(error, t));
            setFlow((current) => ({ ...current }));
          }
        });
    }, 1000);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [flow, isAdditionalAccount, target, onComplete, onExistingAccount, request, t, updateFlow]);

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
        `${loginPath(target, flow.login_id)}/code`,
        { method: "POST", body: { code: submittedCode } },
      );
      updateFlow(next);
      if (next.error?.existing_account_id) onExistingAccount(next.error.existing_account_id);
      if (next.state === "done") await onComplete();
    } catch (error) {
      setActionError(requestErrorMessage(error, t));
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
    activeLogin.current.shouldCancel = false;
    setSubmitting(true);
    setActionError(null);
    try {
      await cancelClaudeAccountLogin(request, target, flow.login_id);
      onClose();
    } catch (error) {
      activeLogin.current.shouldCancel = !isTerminalLoginState(flow.state);
      setActionError(requestErrorMessage(error, t));
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
      const next = await onRestart();
      updateFlow(next);
      if (next.state === "done") await onComplete();
    } catch (error) {
      setActionError(requestErrorMessage(error, t));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const visibleError = actionError ?? (flow.state === "failed" ? claudeAuthErrorMessage(flow.error, t) : null);
  const title = account ? t("accounts.claude.reloginTitle", { value: account.email }) : t("accounts.claude.newAccount");
  const hint = flow.state === "requested"
    ? t("accounts.login.preparingAddress")
    : flow.state === "code_submitted" || flow.state === "verifying"
      ? t("accounts.claude.verifyingAccount")
      : flow.state === "done"
        ? t("accounts.claude.accountListUpdated")
        : null;

  return <section
    className="c724-auth-sheet"
    data-testid="claude-login-sheet"
    data-login-state={flow.state}
    onKeyDown={(event) => {
      // 인라인 시트지만 Esc로 닫는 것이 기대 동작이다. 언마운트 정리가 진행 중 로그인을 취소한다.
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }}
  >
    <div className="c724-auth-sheet-header">
      <span className="c724-auth-sheet-title">{title}</span>
      <Button variant="outline" size="sm" disabled={submitting} onClick={() => void cancel()}>{t("accounts.common.cancel")}</Button>
    </div>
    {flow.state === "url_ready"
      ? isAdditionalAccount ? <p className="c724-auth-hint">{t("accounts.claude.otherAccountBrowser")}</p> : null
      : <div className="c724-login-state-row">
        <span className={`c724-badge ${flow.state === "failed" ? "c724-badge-danger" : flow.state === "done" ? "c724-badge-accent" : "c724-badge-neutral"}`} role="status">
          {flow.state === "verifying" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {stateLabel(flow.state, t)}
        </span>
        {hint ? <p className="c724-auth-hint">{hint}</p> : null}
      </div>}
    {flow.state === "url_ready" && flow.auth_url ? <Button className="c724-login-open-link" variant="outline" size="sm" render={<a href={flow.auth_url} target="_blank" rel="noopener noreferrer" />}>
      <ExternalLink className="size-4" aria-hidden="true" />{" "}{t("accounts.login.openVerification")}
    </Button> : null}
    {visibleError ? <div className="c724-login-error" role="alert">
      <AlertCircle className="size-4" aria-hidden="true" />
      <span data-v3-selectable-content="true">{visibleError}</span>
    </div> : null}
    {flow.state === "url_ready" || flow.state === "failed" || flow.state === "code_submitted" || flow.state === "verifying" ? <div className="c724-auth-code-row">
      <Input
        ref={codeInputRef}
        aria-label={t("accounts.claude.verificationCode")}
        autoComplete="off"
        className="flex-1"
        disabled={isChecking}
        placeholder={t("accounts.claude.verificationPlaceholder")}
        value={code}
        onChange={(event) => setCode(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void submitCode(); }}
      />
      <Button variant="default" size="sm" disabled={isChecking || !code.trim()} onClick={() => void submitCode()}>
        {isChecking ? <><Loader2 className="size-4 animate-spin" aria-hidden="true" />{" "}{t("accounts.common.checking")}</> : flow.state === "failed" ? t("accounts.common.checkAgain") : t("accounts.common.check")}
      </Button>
    </div> : null}
    {flow.state === "failed" ? <div className="c724-login-actions">
      <Button variant="outline" size="sm" disabled={submitting} onClick={() => void restart()}>
        <RotateCcw className="size-4" aria-hidden="true" />{" "}{t("accounts.login.newLink")}
      </Button>
      {flow.auth_url ? <Button variant="outline" size="sm" render={<a href={flow.auth_url} target="_blank" rel="noopener noreferrer" />}>
        <ExternalLink className="size-4" aria-hidden="true" />{" "}{t("accounts.login.openVerification")}
      </Button> : null}
    </div> : null}
  </section>;
}
