import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSessionQueryTools, registerSessionQueryToolsLegacy } from "../../src/mcp/tools/session_query.js";
import { registerSessionMgmtTools, registerSessionNameToolsLegacy } from "../../src/mcp/tools/session_mgmt.js";
import { registerCatalogTools, registerDeleteSessionToolLegacy } from "../../src/mcp/tools/catalog.js";
import { registerOrchestratorTools } from "../../src/mcp/orchestrator_tools.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import { createSessionRoundtripFixture } from "./session-roundtrip-fixture.js";

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
export function assertSessionParity(old: unknown, next: unknown) { expect(JSON.stringify(next)).toBe(JSON.stringify(old)); }

describe("session legacy and orchestrator MCP parity", () => {
  let h: Awaited<ReturnType<typeof createSessionRoundtripFixture>>;
  beforeAll(async () => { h = await createSessionRoundtripFixture(); });
  afterAll(async () => { await h?.app.close(); });
  async function call(legacy: boolean, name: string, args: Record<string, unknown>, context = parent) {
    const server = new McpServer({ name: "session-parity", version: "1" });
    if (legacy) {
      registerSessionQueryToolsLegacy(server, h.runtime); registerSessionNameToolsLegacy(server, h.runtime); registerDeleteSessionToolLegacy(server, h.runtime);
    } else {
      registerSessionQueryTools(server, h.runtime); registerSessionMgmtTools(server, h.runtime); registerCatalogTools(server, h.runtime);
    }
    const client = new Client({ name: "session-parity-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      return await withMcpRequestContext(context, () => client.callTool({ name, arguments: args }));
    } finally { await client.close(); await server.close(); }
  }
  async function compare(name: string, args: Record<string, unknown>, context = parent, settings = {}) {
    h.reset(settings); const old = await call(true, name, args, context);
    const oldRecords = structuredClone(h.observations()); const oldNotifications = structuredClone(h.notifications);
    const oldKeys = [...h.renameKeys];
    h.reset(settings); const next = await call(false, name, args, context);
    assertSessionParity(old, next); expect(h.observations()).toEqual(oldRecords);
    expect(h.notifications).toEqual(oldNotifications); expect(h.renameKeys).toEqual(oldKeys);
    expect(h.paths).toContain(`/api/mcp/host/${name}`);
    expect(h.paths.filter(p => p.startsWith("/api/session-data/host/"))).toEqual([]);
    return next;
  }
  it("preserves local deletion and its notification", async () => {
    h.reset(); const old = await call(true, "delete_session", { session_id: "other" });
    const notices = structuredClone(h.notifications);
    h.reset(); const next = await call(false, "delete_session", { session_id: "other" });
    assertSessionParity(old, next); expect(h.notifications).toEqual(notices);
    expect(h.sessions().other).toBeUndefined(); expect(h.paths).not.toContain("/api/mcp/host/delete_session");
  });
  it("relays remote terminal deletion and notifies once", async () => {
    h.reset(); const result = await call(false, "delete_session", { session_id: "child" });
    expect(result.structuredContent).toEqual({ ok: true, session_id: "child" });
    expect(h.sessions().child).toBeUndefined(); expect(h.notifications).toEqual([{ deleted: "child" }]);
    expect(h.paths).toContain("/api/mcp/host/delete_session");
  });
  it("refuses remote running deletion without stopping a runner", async () => {
    h.reset({ status: "running" }); const result = await call(false, "delete_session", { session_id: "child" });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toBe("Session child on node remote is running; stop it before deleting it");
    expect(h.sessions().child).toBeDefined(); expect(h.notifications).toEqual([]);
  });
  it.each(successes)("preserves %s success %j", async (name, args) => { const result = await compare(name, args); expect(result.isError).not.toBe(true); });
  it.each(errors)("preserves %s error %j", async (name, args) => { const result = await compare(name, args); expect(result.isError).toBe(true); });
  it.each(["turn_summaries", "empty"])("preserves story fallback %s", async story => {
    await compare("get_session_story", { session_id: "child", include_highlight: true }, parent, { story });
    await compare("get_session_highlight", { session_id: "child" }, parent, { story });
  });
  it("preserves partial session search", async () => { await compare("search_sessions", { query: "needle" }, parent, { partial: true }); });
  it.each([external, {}])("preserves query and mutation for identity %j", async context => {
    await compare("get_session_event", { session_id: "child", event_id: 4, caller_session_id: "parent" }, context);
    await compare("search_sessions", { query: "needle" }, context);
    await compare("search_session_history", { query: "needle" }, context);
    await compare("set_session_name", { session_id: "child", name: "이름" }, context);
  });
  it.each([{}, { caller: null }, { status: "running" }])("preserves child observation conditions %j", async settings => {
    await compare("get_session_event", { session_id: "child", event_id: 4 }, parent, settings);
    expect(h.observations().length).toBe(Object.keys(settings).length === 0 ? 1 : 0);
  });
  it("does not observe a partial child revision", async () => {
    await compare("get_session_event", { session_id: "child", event_id: 1 }); expect(h.observations()).toEqual([]);
  });
  it("refuses a child result when the revision changed during observation", async () => {
    const result = await compare("get_session_event", { session_id: "child", event_id: 4 }, parent, { mismatch: true }); expect(result.isError).toBe(true);
  });
  it.each(["get", "list_summary", "event_read_page", "event_count", "event_read_one", "story", "story_search_metadata", "turn_summary_count", "turn_summary_range", "history_search", "turn_excerpt", "record_observed_child_completions"])("preserves repository error %s", async failure => {
    const target: Record<string, [string, Record<string, unknown>]> = {
      list_summary: ["list_sessions", {}], event_read_page: ["list_session_events", { session_id: "child" }],
      event_count: ["list_session_events", { session_id: "child" }], story: ["get_session_story", { session_id: "child" }],
      story_search_metadata: ["search_session_history", { query: "needle" }], history_search: ["search_session_history", { query: "needle" }],
      turn_excerpt: ["get_session_summary", { session_id: "child" }], turn_summary_count: ["get_session_turn_summaries", { session_id: "child", mode: "count" }],
      turn_summary_range: ["get_session_turn_summaries", { session_id: "child", mode: "index", turn_number: 3 }],
    };
    const [name, args] = target[failure] ?? ["get_session_event", { session_id: "child", event_id: 4 }];
    const result = await compare(name, args, parent, { failure }); expect(result.isError).toBe(true);
  });
});
describe("session parity comparator", () => {
  it.each(["content", "structuredContent", "isError"])("detects changed %s", key => {
    const old = { content: [{ type: "text", text: "ok" }], structuredContent: { session_id: "child" }, isError: false };
    expect(() => assertSessionParity(old, { ...old, [key]: "broken" })).toThrow();
  });
  it("detects key order, whitespace, IDs, timestamps and error text", () => {
    const old = { content: [{ type: "text", text: '{\n  "a": 1,\n  "b": 2\n}' }] };
    for (const text of ['{"a":1,"b":2}', '{\n  "b": 2,\n  "a": 1\n}', "other error"]) {
      expect(() => assertSessionParity(old, { content: [{ type: "text", text }] })).toThrow();
    }
    expect(() => assertSessionParity({ session_id: "child", updated_at: "old" }, { session_id: "other", updated_at: "new" })).toThrow();
  });
});
