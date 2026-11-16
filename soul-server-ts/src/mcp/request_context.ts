import { AsyncLocalStorage } from "node:async_hooks";

import type { McpPrincipal } from "../security/session_isolation_contract.js";

export const SOULSTREAM_AGENT_SESSION_HEADER = "x-soulstream-agent-session-id";

export interface McpRequestContext {
  callerSessionId?: string;
  /** 인증 계층이 판정한 요청 principal. 없으면 full로 본다. */
  principal?: McpPrincipal;
}

const storage = new AsyncLocalStorage<McpRequestContext>();

/**
 * 인증 계층이 판정한 principal을 요청 컨텍스트로 옮긴다.
 *
 * restricted와 full 세션 토큰은 그 토큰이 묶은 세션 ID를 쓴다. 서비스
 * 토큰(세션 ID 없음)을 쓴 full 요청은 지금처럼 헤더를 따른다.
 */
export function requestContextForPrincipal(
  principal: McpPrincipal,
  agentSessionHeader: string | undefined,
): McpRequestContext {
  if (principal.tier === "restricted") {
    return { principal, callerSessionId: principal.sessionId };
  }
  return {
    principal,
    callerSessionId: cleanSessionId(principal.sessionId) ?? cleanSessionId(agentSessionHeader),
  };
}

export function withMcpRequestContext<T>(
  context: McpRequestContext,
  fn: () => T,
): T {
  const callerSessionId = cleanSessionId(context.callerSessionId);
  return storage.run(
    {
      ...(callerSessionId ? { callerSessionId } : {}),
      ...(context.principal ? { principal: context.principal } : {}),
    },
    fn,
  );
}

export function getCurrentMcpCallerSessionId(): string | undefined {
  return cleanSessionId(storage.getStore()?.callerSessionId);
}

export function getCurrentMcpPrincipal(): McpPrincipal {
  return storage.getStore()?.principal ?? { tier: "full" };
}

function cleanSessionId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
