import { useState, type ReactNode } from "react";
import { Button, type UsageSummaryProvider } from "@seosoyoung/soul-ui";
import { AGENT_LOGIN_PROVIDER_LABEL, type AgentLoginProvider } from "../../lib/agent-login-api";
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
  const [phase, setPhase] = useState<Phase>("idle");
  if (provider === null || usage.login_supported !== true) return { action: null, panel: null };

  const label = AGENT_LOGIN_PROVIDER_LABEL[provider];
  const connected = usage.status === "auto";
  const action = <Button
    size="sm"
    variant={connected ? "outline" : "default"}
    data-testid={`agent-login-button-${provider}`}
    disabled={phase !== "idle"}
    onClick={() => setPhase(connected ? "confirming" : "sheet")}
  >{connected ? "다시 연결" : "연결"}</Button>;

  const panel = phase === "confirming"
    ? <div className="c724-confirm-bar" data-testid={`agent-login-confirm-${provider}`}>
      <span className="c724-confirm-text">{label}을 다시 연결할까요? 지금의 로그인이 새 로그인으로 바뀝니다.</span>
      <div className="c724-confirm-actions">
        <Button variant="outline" size="sm" onClick={() => setPhase("idle")}>취소</Button>
        <Button size="sm" onClick={() => setPhase("sheet")}>다시 연결</Button>
      </div>
    </div>
    : phase === "sheet"
      ? <AgentLoginSheet
        nodeId={nodeId}
        provider={provider}
        request={request}
        onClose={() => setPhase("idle")}
        onDone={() => onUsageChanged?.()}
      />
      : null;
  return { action, panel };
}
