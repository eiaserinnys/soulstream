import type { AgentLoginProvider } from "./types.js";

const LOGIN_BACKEND_BY_PROVIDER: Record<AgentLoginProvider, string> = {
  codex: "codex",
  antigravity: "antigravity",
};

/** 노드가 Codex나 Antigravity 백엔드를 지원하면 로그인 명령을 처리한다(등록 능력 agent_login_v1). */
export function supportsAgentLogin(supportedBackends: readonly string[]): boolean {
  return Object.values(LOGIN_BACKEND_BY_PROVIDER).some((backend) => supportedBackends.includes(backend));
}
