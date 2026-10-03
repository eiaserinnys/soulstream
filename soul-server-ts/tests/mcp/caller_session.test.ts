import { describe, expect, it } from "vitest";

import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import {
  resolveMcpCallerAttribution
} from "../../src/mcp/tools/caller_session.js";

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
});
