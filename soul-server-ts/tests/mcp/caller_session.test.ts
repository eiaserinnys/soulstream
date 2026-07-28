import { describe, expect, it } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  MISSING_REMOTE_CALLER_SESSION_ID_ERROR,
  requireRemoteCallerAttribution,
  resolveEffectiveCallerSessionId,
  resolveMcpCallerAttribution,
} from "../../src/mcp/tools/caller_session.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";

function makeRuntime(): McpRuntime {
  return {
    nodeId: "node-test",
    taskManager: {
      getTask: (sessionId: string) => (
        sessionId === "caller-session"
          ? { profileId: "codex-default" }
          : undefined
      ),
    },
    agentRegistry: {
      get: (agentId: string) => (
        agentId === "codex-default"
          ? { name: "Codex", portrait_path: "/portrait.png" }
          : undefined
      ),
    },
  } as unknown as McpRuntime;
}

describe("MCP caller attribution", () => {
  it("내부 호출자는 명시 caller_session_id를 종전처럼 우선한다", () => {
    const result = withMcpRequestContext(
      { callerSessionId: "header-session" },
      () => resolveMcpCallerAttribution(makeRuntime(), "caller-session"),
    );

    expect(result.callerSessionId).toBe("caller-session");
    expect(result.callerInfo).toEqual(expect.objectContaining({
      source: "agent",
      agent_id: "codex-default",
    }));
  });

  it("llm origin은 명시 caller_session_id를 구조 부모로 가장하지 않는다", () => {
    const result = withMcpRequestContext(
      { callerOrigin: "llm", callerSessionId: "header-session" },
      () => resolveMcpCallerAttribution(makeRuntime(), "caller-session"),
    );

    expect(result).toEqual({
      callerSessionId: undefined,
      callerInfo: {
        source: "llm",
        agent_node: "node-test",
        display_name: "External LLM",
        user_id: null,
        avatar_url: null,
      },
    });
  });

  it("llm origin은 결과 조회의 소비 기록에도 명시 session id를 가장하지 않는다", () => {
    const result = withMcpRequestContext(
      { callerOrigin: "llm", callerSessionId: "spoofed-session" },
      () => resolveEffectiveCallerSessionId("another-spoofed-session"),
    );

    expect(result).toBeUndefined();
  });

  it("llm origin은 부모 세션 없이 remote 위임 attribution을 만든다", () => {
    const result = withMcpRequestContext(
      { callerOrigin: "llm" },
      () => requireRemoteCallerAttribution(makeRuntime(), undefined),
    );

    expect(result).toEqual({
      ok: true,
      callerSessionId: undefined,
      callerInfo: expect.objectContaining({ source: "llm" }),
    });
  });

  it("origin 없는 기존 클라이언트는 부모 세션 없이 remote 위임할 수 없다", () => {
    const result = withMcpRequestContext(
      {},
      () => requireRemoteCallerAttribution(makeRuntime(), undefined),
    );

    expect(result).toEqual({
      ok: false,
      error: MISSING_REMOTE_CALLER_SESSION_ID_ERROR,
    });
  });
});
