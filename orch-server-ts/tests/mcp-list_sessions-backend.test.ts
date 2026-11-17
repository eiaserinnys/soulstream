import { describe, expect, it } from "vitest";
import { sessionListQueryHandlers } from "../src/mcp/session_list_query_handlers.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

describe("list_sessions backend", () => {
  it("reports the preset backend while preserving session_type", async () => {
    const row = { display_name: null, status: "completed", session_type: "claude",
      created_at: new Date(), updated_at: new Date(), event_count: 0,
      caller_session_id: null, away_summary: null, agent_id: null, node_id: "node" };
    const sessions = [
      { ...row, session_id: "codex", model_preset: "codex-6.1-terra" },
      { ...row, session_id: "missing", model_preset: null },
      { ...row, session_id: "unknown", model_preset: "unknown-preset" },
    ];
    const options = {
      sessions: { repositoryProvider: async () => ({ sessionReads: {
        listSessionsSummary: async () => ({ sessions, total: sessions.length }),
      } }) },
      cluster: { centralAgentProfiles: { modelCatalog: repositoryModelCatalog() } },
    } as unknown as McpHostOptions;
    const result = await sessionListQueryHandlers.list_sessions(options, {}, {
      principal: "internal", callerSessionId: null, nodeId: "node",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.sessions).toEqual([
      expect.objectContaining({ session_id: "codex", session_type: "claude", model_preset: "codex-6.1-terra", backend: "codex" }),
      expect.objectContaining({ session_id: "missing", session_type: "claude", model_preset: null, backend: null }),
      expect.objectContaining({ session_id: "unknown", session_type: "claude", model_preset: "unknown-preset", backend: null }),
    ]);
  });
});
