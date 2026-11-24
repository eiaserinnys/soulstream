/**
 * Codex와 Antigravity 화면 로그인 호출(오케스트레이터의 agent-logins 경로).
 * 요청과 오류 해석은 Claude 풀 로그인(claude-auth-api)을 그대로 쓰고, HTTP 상태와 오류 code에만 기댄다.
 * 서버가 준 오류 문장, 인증 주소, 일회용 코드는 화면 문구에 섞거나 기록하지 않는다.
 */

import { ClaudeAuthRequestError, requestClaudeAuthData } from "./claude-auth-api";

export type AgentLoginProvider = "codex" | "antigravity";

export type AgentLoginState =
  | "requested"
  | "url_ready"
  | "code_submitted"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled";

export type AgentLoginFlow = {
  login_id: string;
  provider: AgentLoginProvider;
  state: AgentLoginState;
  auth_url: string | null;
  user_code: string | null;
  expects_code: boolean;
  expires_at: string | null;
  error: { code: string; message: string } | null;
};

export const AGENT_LOGIN_PROVIDER_LABEL: Record<AgentLoginProvider, string> = {
  codex: "Codex",
  antigravity: "Antigravity",
};

export function isTerminalAgentLoginState(state: AgentLoginState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

function loginsPath(nodeId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/agent-logins`;
}

function loginPath(nodeId: string, loginId: string): string {
  return `${loginsPath(nodeId)}/${encodeURIComponent(loginId)}`;
}

export function startAgentLogin(request: typeof fetch, nodeId: string, provider: AgentLoginProvider): Promise<AgentLoginFlow> {
  return requestClaudeAuthData<AgentLoginFlow>(request, `${loginsPath(nodeId)}/${encodeURIComponent(provider)}`, { method: "POST" });
}

export function getAgentLogin(request: typeof fetch, nodeId: string, loginId: string): Promise<AgentLoginFlow> {
  return requestClaudeAuthData<AgentLoginFlow>(request, loginPath(nodeId, loginId));
}

export function submitAgentLoginCode(request: typeof fetch, nodeId: string, loginId: string, code: string): Promise<AgentLoginFlow> {
  return requestClaudeAuthData<AgentLoginFlow>(request, `${loginPath(nodeId, loginId)}/code`, { method: "POST", body: { code } });
}

export function cancelAgentLogin(request: typeof fetch, nodeId: string, loginId: string): Promise<AgentLoginFlow> {
  return requestClaudeAuthData<AgentLoginFlow>(request, loginPath(nodeId, loginId), { method: "DELETE" });
}

/** 인증 주소는 http(s)만 링크로 쓴다. 그 밖의 값은 단추로 열지 않는다. */
export function safeAuthUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** failed 상태의 error.code별 안내. 서버 문장은 쓰지 않는다. */
export function agentLoginFailureMessage(provider: AgentLoginProvider, code: string | null | undefined): string {
  const label = AGENT_LOGIN_PROVIDER_LABEL[provider];
  switch (code) {
    case "device_code_disabled":
      return "ChatGPT 설정의 보안 항목에서 Codex 기기 코드 인증을 켠 뒤 다시 시도해 주세요.";
    case "invalid_code":
      return "인증 코드가 맞지 않습니다. 다시 시도하면 새 주소가 열립니다.";
    case "timeout":
      return "제한 시간 안에 인증이 끝나지 않았습니다. 다시 시도해 주세요.";
    case "cli_exited":
      return `${label} CLI가 로그인 도중 종료되었습니다. 다시 시도해 주세요.`;
    case "verify_failed":
      return `로그인은 끝났지만 ${label} 사용량 확인을 통과하지 못했습니다. 계정과 구독 상태를 확인한 뒤 다시 시도해 주세요.`;
    case "cancelled_by_new_login":
      return "새 로그인 요청이 시작되어 이 로그인은 취소되었습니다.";
    default:
      return "로그인을 완료하지 못했습니다. 다시 시도해 주세요.";
  }
}

/** 요청 자체가 실패한 경우의 안내. HTTP 상태와 오류 code만 본다. */
export function agentLoginRequestErrorMessage(provider: AgentLoginProvider, error: unknown): string {
  const label = AGENT_LOGIN_PROVIDER_LABEL[provider];
  if (error instanceof ClaudeAuthRequestError) {
    const code = error.apiError?.code ?? null;
    if (code === "cli_not_installed" || code === "agent_login_unsupported") return `이 노드에 ${label} CLI가 없습니다.`;
    if (code === "node_not_connected") return "노드가 연결되어 있지 않습니다. 연결을 확인한 뒤 다시 시도해 주세요.";
    if (code === "login_not_found") return "이 로그인 요청을 찾을 수 없습니다. 다시 시도해 주세요.";
    if (code === "login_not_ready") return "아직 코드를 받을 수 있는 단계가 아닙니다.";
    if (code === "code_not_expected") return `${label}은 코드를 붙여 넣지 않고 브라우저에서 승인합니다.`;
    if (error.status === 403) return "관리자만 코딩 에이전트를 연결할 수 있습니다.";
    if (error.status === 502) return "노드의 워커가 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
    return `요청에 실패했습니다 (HTTP ${error.status}).`;
  }
  return "요청을 보내지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.";
}
