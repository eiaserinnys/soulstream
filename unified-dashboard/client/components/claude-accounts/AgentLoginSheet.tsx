import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import { AlertCircle, Check, Copy, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import {
  AGENT_LOGIN_PROVIDER_LABEL,
  agentLoginFailureMessage,
  agentLoginRequestErrorMessage,
  cancelAgentLogin,
  getAgentLogin,
  isTerminalAgentLoginState,
  safeAuthUrl,
  startAgentLogin,
  submitAgentLoginCode,
  type AgentLoginProvider,
} from "../../lib/agent-login-api";
import type { AgentLoginFlow } from "../../../../packages/wire-schema/generated/typescript/index";

type Props = {
  nodeId: string;
  provider: AgentLoginProvider;
  request: typeof fetch;
  onClose: () => void;
  /** 로그인이 끝나(done) 사용량 요약을 다시 읽을 때가 되었다. 한 번만 부른다. */
  onDone: () => void;
};

const POLL_INTERVAL_MS = 1000;

/**
 * Codex와 Antigravity 화면 로그인 시트. ClaudeAuthLoginSheet와 같은 흐름이다.
 * 열면 로그인을 시작하고, 끝나기 전에는 1초마다 상태를 읽으며, 닫거나 사라지면 진행 중인 로그인을 취소한다.
 * 일회용 코드, 인증 주소, 붙여 넣은 코드는 화면 밖(콘솔, 로그, 오류 보고)에 내보내지 않는다.
 */
export function AgentLoginSheet({ nodeId, provider, request, onClose, onDone }: Props) {
  const label = AGENT_LOGIN_PROVIDER_LABEL[provider];
  const [flow, setFlow] = useState<AgentLoginFlow | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  // 열 때 한 번만 시작한다. StrictMode가 효과를 두 번 돌려도 로그인은 하나다.
  const started = useRef(false);
  const lifecycle = useRef(0);
  const activeLogin = useRef<{ loginId: string; shouldCancel: boolean } | null>(null);
  const unmounted = useRef(false);
  const doneNotified = useRef(false);
  const sheetRef = useRef<HTMLElement>(null);
  const context = useRef({ nodeId, request, onDone });
  context.current = { nodeId, request, onDone };

  const accept = useCallback((next: AgentLoginFlow) => {
    activeLogin.current = { loginId: next.login_id, shouldCancel: !isTerminalAgentLoginState(next.state) };
    setFlow(next);
    if (next.state === "done" && !doneNotified.current) {
      doneNotified.current = true;
      context.current.onDone();
    }
  }, []);

  const start = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    setCode("");
    setFlow(null);
    doneNotified.current = false;
    try {
      const next = await startAgentLogin(context.current.request, context.current.nodeId, provider);
      if (unmounted.current) {
        // 응답을 기다리는 사이 시트가 닫혔다. 시작된 로그인을 남기지 않는다.
        if (!isTerminalAgentLoginState(next.state)) void cancelAgentLogin(context.current.request, context.current.nodeId, next.login_id).catch(() => undefined);
        return;
      }
      accept(next);
    } catch (caught) {
      if (!unmounted.current) setMessage(agentLoginRequestErrorMessage(provider, caught));
    } finally {
      inFlight.current = false;
      if (!unmounted.current) setBusy(false);
    }
  }, [accept, provider]);

  useEffect(() => {
    unmounted.current = false;
    const mounted = ++lifecycle.current;
    if (!started.current) {
      started.current = true;
      void start();
    }
    return () => {
      unmounted.current = true;
      // StrictMode의 모의 해제는 곧바로 다시 마운트되므로 한 틱 뒤에 아직 해제 상태일 때만 취소한다.
      void Promise.resolve().then(() => {
        if (lifecycle.current !== mounted) return;
        const pending = activeLogin.current;
        if (!pending?.shouldCancel) return;
        const current = context.current;
        void cancelAgentLogin(current.request, current.nodeId, pending.loginId).catch(() => undefined);
      });
    };
  }, [start]);

  const polling = flow !== null && !isTerminalAgentLoginState(flow.state);
  const loginId = flow?.login_id ?? null;
  const state = flow?.state ?? null;
  useEffect(() => {
    if (!polling || !loginId) return;
    let active = true;
    const timer = globalThis.setTimeout(() => {
      void getAgentLogin(context.current.request, context.current.nodeId, loginId)
        .then((next) => {
          if (!active) return;
          setMessage(null);
          accept(next);
        })
        .catch((caught: unknown) => {
          if (!active) return;
          setMessage(agentLoginRequestErrorMessage(provider, caught));
          // 같은 상태로 다시 그려 다음 읽기를 예약한다.
          setFlow((current) => current ? { ...current } : current);
        });
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      globalThis.clearTimeout(timer);
    };
  }, [accept, flow, loginId, polling, provider, state]);

  async function submitCode() {
    if (!flow || inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const submitted = code.trim();
    // 붙여 넣은 코드는 보낸 즉시 화면 상태에서 지운다.
    setCode("");
    try {
      accept(await submitAgentLoginCode(context.current.request, context.current.nodeId, flow.login_id, submitted));
    } catch (caught) {
      setMessage(agentLoginRequestErrorMessage(provider, caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    if (inFlight.current) return;
    const pending = activeLogin.current;
    if (!pending?.shouldCancel) { onClose(); return; }
    inFlight.current = true;
    setBusy(true);
    pending.shouldCancel = false;
    try {
      await cancelAgentLogin(context.current.request, context.current.nodeId, pending.loginId);
      onClose();
    } catch (caught) {
      pending.shouldCancel = true;
      setMessage(agentLoginRequestErrorMessage(provider, caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // 초점은 시트가 지금 기다리는 첫 동작으로 간다. 열 때는 시트 자신(연결 단추가 비활성이 되어도 초점이 사라지지 않게),
  // 주소가 오면 「주소 열기」(Antigravity는 코드 입력칸), 실패하면 「다시 시도」.
  const focusKey = flow ? `${flow.state}:${flow.expects_code ? "code" : "open"}` : message ? "error" : "starting";
  useEffect(() => {
    const root = sheetRef.current;
    if (!root) return;
    const target = focusKey === "url_ready:code" ? root.querySelector<HTMLElement>("input")
      : focusKey.startsWith("url_ready") ? root.querySelector<HTMLElement>("a[href]")
        : focusKey === "error" || focusKey.startsWith("failed") || focusKey.startsWith("cancelled") ? root.querySelector<HTMLElement>("[data-retry]")
          : null;
    // 단계가 바뀌면 시트의 키가 달라진다(주소와 코드가 오면 커진다). 초점만으로는 첫 동작만 보이므로 시트 전체를 스크롤 영역 안으로 가져온다.
    (target ?? root).focus({ preventScroll: true });
    root.scrollIntoView?.({ block: "nearest" });
  }, [focusKey]);

  const authUrl = safeAuthUrl(flow?.auth_url ?? null);
  const terminal = flow !== null && isTerminalAgentLoginState(flow.state);
  const failedText = flow?.state === "failed" ? agentLoginFailureMessage(provider, flow.error?.code) : null;
  const visibleError = message ?? failedText ?? (flow?.state === "cancelled" ? "로그인이 취소되었습니다." : null);
  const asksForCode = flow?.state === "url_ready" && flow.expects_code;
  const showsDeviceCode = flow?.state === "url_ready" && !flow.expects_code && Boolean(flow.user_code);

  return <section
    ref={sheetRef}
    tabIndex={-1}
    className="c724-auth-sheet"
    data-testid="agent-login-sheet"
    data-provider-id={provider}
    data-login-state={flow?.state ?? "starting"}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      void cancel();
    }}
  >
    <div className="c724-auth-sheet-header">
      <span className="c724-auth-sheet-title">{label} 연결</span>
      <Button variant="outline" size="sm" disabled={busy && !terminal} onClick={() => void cancel()}>{terminal ? "닫기" : "취소"}</Button>
    </div>

    {flow === null && !message ? <div className="c724-login-state-row" role="status">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <p className="c724-auth-hint">로그인을 준비하고 있습니다.</p>
    </div> : null}
    {flow?.state === "requested" ? <div className="c724-login-state-row" role="status">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <p className="c724-auth-hint">인증 주소를 준비하고 있습니다.</p>
    </div> : null}

    {flow?.state === "url_ready" ? <>
      <p className="c724-auth-hint">{showsDeviceCode ? "아래 주소를 열고 코드를 넣으세요." : asksForCode ? "아래 주소를 열어 인증을 마치세요." : "아래 주소를 열어 승인하세요."}</p>
      {authUrl ? <Button className="c724-login-open-link" variant="outline" size="sm" render={<a href={authUrl} target="_blank" rel="noopener noreferrer" />}>
        <ExternalLink className="size-4" aria-hidden="true" /> 주소 열기
      </Button> : <p className="c724-login-error" role="alert"><AlertCircle className="size-4" aria-hidden="true" /><span>인증 주소를 열 수 없습니다. 다시 시도해 주세요.</span></p>}
    </> : null}

    {showsDeviceCode && flow?.user_code ? <DeviceCode value={flow.user_code} expiresAt={flow.expires_at} /> : null}

    {asksForCode ? <>
      <p className="c724-auth-hint">브라우저가 보여 준 인증 코드를 붙여 넣으세요.</p>
      <div className="c724-auth-code-row">
        <Input
          aria-label={`${label} 인증 코드`}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1"
          disabled={busy}
          placeholder="인증 코드 붙여넣기"
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submitCode(); }}
        />
        <Button variant="default" size="sm" disabled={busy || !code.trim()} onClick={() => void submitCode()}>제출</Button>
      </div>
    </> : null}

    {flow?.state === "code_submitted" || flow?.state === "verifying" ? <div className="c724-login-state-row" role="status">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <p className="c724-auth-hint">{flow.state === "code_submitted" ? "인증 코드를 확인하고 있습니다." : `${label} 사용량을 확인하고 있습니다.`}</p>
    </div> : null}

    {flow?.state === "done" ? <div className="c724-login-state-row" role="status">
      <span className="c724-badge c724-badge-accent"><Check className="size-3.5" aria-hidden="true" /> 연결되었습니다</span>
    </div> : null}

    {visibleError ? <div className="c724-login-error" role="alert">
      <AlertCircle className="size-4" aria-hidden="true" />
      <span data-v3-selectable-content="true">{visibleError}</span>
    </div> : null}

    {(flow === null && message) || (flow !== null && (flow.state === "failed" || flow.state === "cancelled")) ? <div className="c724-login-actions">
      <Button data-retry variant="outline" size="sm" disabled={busy} onClick={() => void start()}>
        <RotateCcw className="size-4" aria-hidden="true" /> 다시 시도
      </Button>
    </div> : null}
  </section>;
}

function DeviceCode({ value, expiresAt }: { value: string; expiresAt: string | null }) {
  const [copied, setCopied] = useState(false);
  const remaining = useRemainingSeconds(expiresAt);
  return <div className="c724-device-code">
    <code className="c724-device-code-value" data-testid="agent-login-user-code" data-v3-selectable-content="true">{value}</code>
    <Button variant="outline" size="sm" onClick={() => {
      void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined);
    }}>
      {copied ? <><Check className="size-4" aria-hidden="true" /> 복사됨</> : <><Copy className="size-4" aria-hidden="true" /> 복사</>}
    </Button>
    {remaining !== null ? <span className="c724-meta-inline" data-testid="agent-login-remaining">{remaining > 0 ? `남은 시간 ${formatRemaining(remaining)}` : "코드가 만료되었습니다"}</span> : null}
  </div>;
}

function useRemainingSeconds(expiresAt: string | null): number | null {
  const target = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const valid = Number.isFinite(target);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!valid) return;
    setNow(Date.now());
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [valid, target]);
  return valid ? Math.max(0, Math.ceil((target - now) / 1000)) : null;
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
