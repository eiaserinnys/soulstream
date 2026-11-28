import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, type UsageSummaryProvider } from "@seosoyoung/soul-ui";
import type { AgentLoginProvider } from "../../lib/agent-login-api";
import { AgentLoginSheet } from "./AgentLoginSheet";

type Phase = "idle" | "confirming" | "sheet";

/**
 * Codex와 Antigravity 행의 로그인 단추와 그 아래 확인줄, 로그인 시트.
 * 워커가 능력(login_supported)을 알린 행에만 단추가 있고, 없거나 필드가 없으면 아무것도 그리지 않는다.
 * 연결되어 있으면(status auto) 「다시 연결」이며 한 번 확인을 받는다.
 */
export function useAgentLoginRowAction({ nodeId, provider, usage, request, onUsageChanged }: {
  nodeId: string;
  /** 화면 로그인이 있는 공급자. 없는 공급자(OpenCode Go)는 null이다. */
  provider: AgentLoginProvider | null;
  usage: UsageSummaryProvider;
  request: typeof fetch;
  /** 로그인이 끝나 그 노드의 사용량 요약을 다시 읽을 때. */
  onUsageChanged?: () => void;
}): { action: ReactNode; panel: ReactNode } {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("idle");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  // 확인줄이 열리면 첫 동작(취소)에 초점을 둔다.
  useEffect(() => {
    if (phase === "confirming") confirmCancelRef.current?.focus();
  }, [phase]);

  if (provider === null || usage.login_supported !== true) return { action: null, panel: null };

  const connected = usage.status === "auto";
  // 닫기 전에 초점을 눌렀던 단추로 먼저 옮긴다. 초점이 있는 요소가 사라진 뒤에는 설정창이 초점을 창 머리로 되돌린다.
  const close = () => {
    buttonRef.current?.focus();
    setPhase("idle");
  };
  // 열려 있는 동안 단추는 비활성 모양(투명도 0.64, 눌러도 반응 없음)이지만 disabled 속성은 쓰지 않는다.
  // disabled가 되면 눌렀던 단추의 초점이 사라진다.
  const open = phase !== "idle";
  const action = <Button
    ref={buttonRef}
    size="sm"
    variant={connected ? "outline" : "default"}
    className="aria-disabled:pointer-events-none aria-disabled:opacity-64 aria-disabled:shadow-none"
    data-testid={`agent-login-button-${provider}`}
    aria-expanded={open}
    aria-disabled={open ? "true" : undefined}
    onClick={() => { if (phase === "idle") setPhase(connected ? "confirming" : "sheet"); }}
  >{connected ? t("accounts.common.reconnect") : t("accounts.common.connect")}</Button>;

  const panel = phase === "confirming"
    ? <div
      className="c724-confirm-bar"
      data-testid={`agent-login-confirm-${provider}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <span className="c724-confirm-text">{t("accounts.login.reconnectPrompt")}</span>
      <div className="c724-confirm-actions">
        <Button ref={confirmCancelRef} variant="outline" size="sm" onClick={close}>{t("accounts.common.cancel")}</Button>
        <Button size="sm" onClick={() => setPhase("sheet")}>{t("accounts.common.reconnect")}</Button>
      </div>
    </div>
    : phase === "sheet"
      ? <AgentLoginSheet
        nodeId={nodeId}
        provider={provider}
        request={request}
        onClose={close}
        onDone={() => onUsageChanged?.()}
      />
      : null;
  return { action, panel };
}
