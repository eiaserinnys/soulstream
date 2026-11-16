/**
 * 인증 principal을 MCP 요청 컨텍스트의 callerSessionId로 옮기는 규칙.
 *
 * full 세션 토큰과 restricted 토큰은 토큰이 묶은 세션을 쓰고, 서비스 토큰
 * (세션 없음)은 지금처럼 에이전트 세션 헤더를 따른다.
 */
import { describe, expect, it } from "vitest";

import {
  getCurrentMcpCallerSessionId,
  getCurrentMcpPrincipal,
  requestContextForPrincipal,
  withMcpRequestContext,
} from "../../src/mcp/request_context.js";

const TOKEN_SESSION = "11111111-1111-4111-8111-111111111111";
const HEADER_SESSION = "header-session";

describe("requestContextForPrincipal", () => {
  it("uses the restricted token session and ignores the header", () => {
    expect(requestContextForPrincipal(
      { tier: "restricted", sessionId: TOKEN_SESSION },
      HEADER_SESSION,
    )).toEqual({
      principal: { tier: "restricted", sessionId: TOKEN_SESSION },
      callerSessionId: TOKEN_SESSION,
    });
  });

  it("uses the full session token session over the header", () => {
    expect(requestContextForPrincipal(
      { tier: "full", sessionId: TOKEN_SESSION },
      HEADER_SESSION,
    )).toEqual({
      principal: { tier: "full", sessionId: TOKEN_SESSION },
      callerSessionId: TOKEN_SESSION,
    });
  });

  it("falls back to the agent session header for the service token", () => {
    expect(requestContextForPrincipal({ tier: "full" }, HEADER_SESSION)).toEqual({
      principal: { tier: "full" },
      callerSessionId: HEADER_SESSION,
    });
  });

  it("has no caller session when neither the token nor the header names one", () => {
    expect(requestContextForPrincipal({ tier: "full" }, undefined)).toEqual({
      principal: { tier: "full" },
      callerSessionId: undefined,
    });
    expect(requestContextForPrincipal({ tier: "full", sessionId: "   " }, undefined))
      .toEqual({ principal: { tier: "full", sessionId: "   " }, callerSessionId: undefined });
  });

  it("carries the principal into the async request store", () => {
    const context = requestContextForPrincipal(
      { tier: "full", sessionId: TOKEN_SESSION },
      undefined,
    );
    const seen = withMcpRequestContext(context, () => ({
      caller: getCurrentMcpCallerSessionId(),
      principal: getCurrentMcpPrincipal(),
    }));
    expect(seen).toEqual({
      caller: TOKEN_SESSION,
      principal: { tier: "full", sessionId: TOKEN_SESSION },
    });
  });
});
