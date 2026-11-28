/**
 * Codex와 Antigravity 화면 로그인 호출(오케스트레이터의 agent-logins 경로).
 * 요청과 오류 해석은 Claude 풀 로그인(claude-auth-api)을 그대로 쓰고, HTTP 상태와 오류 code에만 기댄다.
 * 서버가 준 오류 문장, 인증 주소, 일회용 코드는 화면 문구에 섞거나 기록하지 않는다.
 */

import type { useTranslation } from "react-i18next";
import type { AgentLoginFlow } from "../../../packages/wire-schema/generated/typescript/index";
import { ClaudeAuthRequestError, requestClaudeAuthData } from "./claude-auth-api";

type Translate = ReturnType<typeof useTranslation>["t"];

export type AgentLoginProvider = AgentLoginFlow["provider"];
export type AgentLoginState = AgentLoginFlow["state"];

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
export function agentLoginFailureMessage(provider: AgentLoginProvider, code: string | null | undefined, t: Translate): string {
  const label = AGENT_LOGIN_PROVIDER_LABEL[provider];
  switch (code) {
    case "device_code_disabled":
      return t("accounts.login.deviceCodeDisabled");
    case "invalid_code":
      return t("accounts.login.invalidCode");
    case "timeout":
      return t("accounts.login.timeout");
    case "cli_exited":
      return t("accounts.login.cliExited", { value: label });
    case "verify_failed":
      return t("accounts.login.verifyFailed", { value: label });
    case "cancelled_by_new_login":
      return t("accounts.login.replaced");
    default:
      return t("accounts.login.failed");
  }
}

/** 요청 자체가 실패한 경우의 안내. HTTP 상태와 오류 code만 본다. */
export function agentLoginRequestErrorMessage(provider: AgentLoginProvider, error: unknown, t: Translate): string {
  const label = AGENT_LOGIN_PROVIDER_LABEL[provider];
  if (error instanceof ClaudeAuthRequestError) {
    const code = error.apiError?.code ?? null;
    if (code === "cli_not_installed" || code === "agent_login_unsupported") return t("accounts.login.cliMissing", { value: label });
    if (code === "node_not_connected") return t("accounts.login.offline");
    if (code === "login_not_found") return t("accounts.login.notFound");
    if (code === "login_not_ready") return t("accounts.login.notReady");
    if (code === "code_not_expected") return t("accounts.login.approveInBrowser");
    if (error.status === 403) return t("accounts.login.adminOnly");
    if (error.status === 502) return t("accounts.login.workerFailed");
    return t("accounts.login.httpError", { value: error.status });
  }
  return t("accounts.login.networkError");
}
