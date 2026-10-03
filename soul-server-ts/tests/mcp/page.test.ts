import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerPageTools } from "../../src/mcp/tools/page.js";

describe("page MCP tools", () => {
  it("registers exactly the eight spec tools and caller_session_id on every input", () => {
    const { registered } = register();
    expect([...registered.keys()]).toEqual([
      "get_page",
      "find_page",
      "get_page_markdown",
      "get_backlinks",
      "create_page",
      "batch_page_operations",
      "upsert_page_markdown",
      "get_daily_page",
    ]);
    for (const value of registered.values()) {
      expect(Object.keys(value.config.inputSchema)).toContain("caller_session_id");
    }
  });

});
function register() {
  const registered = new Map<string, { config: { inputSchema: Record<string, unknown> } }>();
  const server = { registerTool(name: string, config: { inputSchema: Record<string, unknown> }) {
    registered.set(name, { config });
  } } as unknown as McpServer;
  registerPageTools(server, { logger: { warn: vi.fn() } } as unknown as McpRuntime);
  return { registered };
}
