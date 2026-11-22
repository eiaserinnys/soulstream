import type { CallToolResult } from "@soulstream/mcp-contract";
import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionRoundtripFixture } from "../../../soul-server-ts/tests/mcp/session-roundtrip-fixture.js";

const parent: McpRequestContext = { callerSessionId: "parent" };
const external: McpRequestContext = { callerSessionId: "parent", principal: { authority: "external", source: "llm", displayName: "Dot" } };

describe("session MCP roundtrip", () => {
  let h: Awaited<ReturnType<typeof createSessionRoundtripFixture>>;
  beforeAll(async () => { h = await createSessionRoundtripFixture(); });
  afterAll(async () => { await h?.app.close(); });
  async function call(name: string, args: Record<string, unknown>, context = parent){ const value: CallToolResult = await executeMcpTool(h.options as unknown as McpHostOptions, name as never, args, { principal: "external", callerSessionId: null, nodeId: "local" }); const { content, structuredContent, isError, ...rest } = value; return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) }; }
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
