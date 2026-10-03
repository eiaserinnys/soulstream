import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRoundtripFixture } from "../../../soul-server-ts/tests/mcp/session-roundtrip-fixture.js";

const parent: McpRequestContext = { callerSessionId: "parent" };
const external: McpRequestContext = { callerSessionId: "parent", principal: { authority: "external", source: "llm", displayName: "Dot" } };
const successes: [string, Record<string, unknown>][] = [
  ["list_sessions", {}], ["list_sessions", { folder_name: "폴더", limit: 1, cursor: 1 }],
  ["list_sessions", { search: "missing", node_name: "remote" }], ["list_sessions", { folder_name: "missing" }],
  ["list_session_events", { session_id: "child", limit: 2, tool_truncate_chars: 5 }],
  ["list_session_events", { session_id: "child", tool_content: "full", cursor: 1 }],
  ["list_session_events", { session_id: "child", tool_content: "omit" }],
  ["get_session_event", { session_id: "child", event_id: 4 }],
  ["get_session_story", { session_id: "child" }], ["get_session_story", { session_id: "child", include_highlight: true }],
  ["get_session_highlight", { session_id: "child" }],
  ["get_session_summary", { session_id: "child", max_response_chars: 3 }],
  ["get_session_turn_summaries", { session_id: "child", mode: "count" }],
  ["get_session_turn_summaries", { session_id: "child", mode: "index", turn_number: 3 }],
  ["get_session_turn_summaries", { session_id: "child", mode: "index", turn_number: 99 }],
  ["get_session_turn_summaries", { session_id: "child", mode: "range", from_turn_number: 1, limit: 1 }],
  ["search_session_history", { query: "needle" }], ["search_session_history", { query: "needle", session_ids: ["parent"] }],
  ["search_session_history", { query: "needle", event_types: ["tool_result"] }],
  ["search_session_history", { query: "needle", session_ids: ["missing"] }],
  ["search_sessions", { query: "needle", top_k: 1 }], ["search_sessions", { query: "missing" }],
  ["get_session_name", { session_id: "child" }],
  ["set_session_name", { session_id: "child", name: "  새 이름  " }], ["set_session_name", { session_id: "child", name: "  " }],
];
const sessionTools = ["list_session_events", "get_session_event", "get_session_story", "get_session_highlight", "get_session_summary", "get_session_turn_summaries", "get_session_name", "set_session_name"];
const defaults: Record<string, Record<string, unknown>> = { get_session_event: { event_id: 4 }, get_session_turn_summaries: { mode: "count" } };
const errors: [string, Record<string, unknown>][] = [
  ...sessionTools.map(name => [name, { session_id: "missing", ...defaults[name] }] as [string, Record<string, unknown>]),
  ["get_session_event", { session_id: "child", event_id: 999 }],
  ["get_session_turn_summaries", { session_id: "child", mode: "index" }],
  ["get_session_turn_summaries", { session_id: "child", mode: "range" }],
  ["get_session_turn_summaries", { session_id: "child", mode: "range", from_turn_number: 2, to_turn_number: 1 }],
];

// No random values are returned by these 12 tools. No fields (including dates) are masked.

describe("session MCP roundtrip", () => {
  let h: Awaited<ReturnType<typeof createSessionRoundtripFixture>>;
  beforeAll(async () => { h = await createSessionRoundtripFixture(); });
  afterAll(async () => { await h?.app.close(); });
  async function call(name: string, args: Record<string, unknown>, context = parent){ const value = await executeMcpTool(h.options as unknown as McpHostOptions, name as never, args, { principal: "external", callerSessionId: null, nodeId: "local" }); const { content, structuredContent, isError, ...rest } = value; return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) }; }
  async function roundtrip(name: string, args: Record<string, unknown>, context = parent, settings = {}) {
    h.reset(settings); const next = await call(name, args, context);
    expect(JSON.stringify(next)).toMatchSnapshot(name);
    expect(JSON.stringify({ observations: h.observations(), notifications: h.notifications, renameKeys: h.renameKeys })).toMatchSnapshot(`${name} effects`);


    return next;
  }
  it.each([external])("preserves query and mutation for identity %j", async context => {
    await roundtrip("get_session_event", { session_id: "child", event_id: 4, caller_session_id: "parent" }, context);
    await roundtrip("search_sessions", { query: "needle" }, context);
    await roundtrip("search_session_history", { query: "needle" }, context);
    await roundtrip("set_session_name", { session_id: "child", name: "이름" }, context);
  });
});
