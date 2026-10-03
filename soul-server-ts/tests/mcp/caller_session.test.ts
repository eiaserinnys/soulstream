import { describe, expect, it } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  MISSING_REMOTE_CALLER_SESSION_ID_ERROR,
  requireRemoteCallerAttribution,
  resolveEffectiveCallerSessionId,
  resolveMcpCallerAttribution,
  resolveMcpMutationActor,
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
