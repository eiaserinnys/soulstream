import { describe, expect, it, vi } from "vitest";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";
import type { McpHostOptions } from "../src/mcp/types.js";

function setup() {
  const search = vi.fn().mockResolvedValue({ events: [], sessionIdEvents: [], digests: [] });
  const repositories = {
    historySearch: { search },
    storyReads: { getSessionSearchMetadata: vi.fn().mockResolvedValue([]) },
  } as unknown as PersistenceHostRepositories;
  const options = { sessions: { repositoryProvider: async () => repositories } } as unknown as McpHostOptions;
  const call = (args: Record<string, unknown>) => executeMcpTool(options, "search_session_history", args, {
    principal: "external", callerSessionId: null, nodeId: "test",
  });
  return { search, call };
}

describe("search_session_history input", () => {
  it("rejects the unknown singular session_id before searching", async () => {
    const { search, call } = setup();
    const result = await call({ query: "test", session_id: "session-one" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("session_id");
    expect(search).not.toHaveBeenCalled();
  });

  it("passes session_ids to the search backend", async () => {
    const { search, call } = setup();
    const result = await call({ query: "test", session_ids: ["session-one"] });
    expect(result.isError).not.toBe(true);
    expect(result).toMatchObject({ structuredContent: { results: [] } });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ["session-one"] }), expect.any(AbortSignal));
  });
});
