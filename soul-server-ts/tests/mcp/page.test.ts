import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import { registerPageTools } from "../../src/mcp/tools/page.js";

describe("page MCP tools", () => {
  it("registers exactly the eight spec tools and caller_session_id on every input", () => {
    const { registered } = register(fakeClient());
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

  it("omits blocks when get_page include_blocks is false", async () => {
    const client = fakeClient();
    client.getPage.mockResolvedValue({ page: page() });
    const { call } = register(client);

    const result = await call("get_page", { page_id: "page-1", include_blocks: false });

    expect(result.structuredContent).toEqual({ page: page() });
    expect(client.getPage).toHaveBeenCalledWith("page-1", false);
  });

  it("uses explicit caller_session_id for create and preserves operation output", async () => {
    const client = fakeClient();
    const { call } = register(client);
    const result = await call("create_page", {
      title: "Page",
      id: "page-1",
      idempotency_key: "create_page:session-1:req",
      caller_session_id: "session-1",
    });

    expect(result.structuredContent).toMatchObject({
      page: { id: "page-1" },
      created: true,
      operation: { id: "op-1" },
    });
    expect(client.createPage).toHaveBeenCalledWith(expect.objectContaining({
      actorSessionId: "session-1",
      idempotencyKey: "create_page:session-1:req",
    }));
  });

  it("falls back to the request header for lazy daily creation", async () => {
    const client = fakeClient();
    const { call } = register(client);
    await withMcpRequestContext({ callerSessionId: "header-session" }, async () =>
      await call("get_daily_page", { date: "2026-07-12" }));
    expect(client.getDailyPage).toHaveBeenCalledWith({
      date: "2026-07-12",
      actorSessionId: "header-session",
    });
  });

  it("rejects invalid XOR and missing CAS before calling the host", async () => {
    const client = fakeClient();
    const { call } = register(client);
    const result = await call("batch_page_operations", {
      page_id: "page-1",
      operations: [{ op: "rename_page", title: "Renamed" }],
      idempotency_key: "batch:1",
      caller_session_id: "session-1",
    });
    expect(result.isError).toBe(true);
    expect(client.batchPageOperations).not.toHaveBeenCalled();
  });

  it("renders block IDs in markdown and performs explicit full replacement", async () => {
    const client = fakeClient();
    client.getPage
      .mockResolvedValueOnce({
        page: page(),
        blocks: [block("root", null, "구현")],
      })
      .mockResolvedValueOnce({ page: page() });
    const { call } = register(client);

    const markdown = await call("get_page_markdown", {
      page_id: "page-1",
      include_block_ids: true,
    });
    expect(markdown.content[0]?.text).toContain("<!-- block:root -->");

    const replaced = await call("upsert_page_markdown", {
      page_id: "page-1",
      expected_version: 1,
      markdown: "# Page\n\n교체",
      idempotency_key: "replace:1",
      caller_session_id: "session-1",
    });
    expect(replaced.structuredContent).toMatchObject({ created: false, operation: { id: "op-1" } });
    expect(client.replacePageMarkdown).toHaveBeenCalledWith(expect.objectContaining({
      pageId: "page-1",
      expectedVersion: 1,
      actorSessionId: "session-1",
      blocks: [expect.objectContaining({ text: "교체" })],
    }));
  });

  it("excludes self backlinks by default and forwards the explicit opt-in", async () => {
    const client = fakeClient();
    const { call } = register(client);

    await call("get_backlinks", { page_id: "page-1" });
    await call("get_backlinks", { page_id: "page-1", include_self: true });

    expect(client.getBacklinks).toHaveBeenNthCalledWith(1, expect.objectContaining({
      pageId: "page-1",
      includeSelf: false,
    }));
    expect(client.getBacklinks).toHaveBeenNthCalledWith(2, expect.objectContaining({
      pageId: "page-1",
      includeSelf: true,
    }));
  });
});

function register(client: ReturnType<typeof fakeClient>) {
  const registered = new Map<string, { config: { inputSchema: Record<string, unknown> }; handler: Function }>();
  const server = {
    registerTool(name: string, config: { inputSchema: Record<string, unknown> }, handler: Function) {
      registered.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerPageTools(server, {
    pageHostClient: client,
    logger: { warn: vi.fn() },
  } as unknown as McpRuntime);
  return {
    registered,
    async call(name: string, input: Record<string, unknown>) {
      const tool = registered.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return await tool.handler(input, {});
    },
  };
}

function fakeClient() {
  return {
    getPage: vi.fn().mockResolvedValue({ page: page(), blocks: [] }),
    findPage: vi.fn().mockResolvedValue({ page: page() }),
    getBacklinks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    createPage: vi.fn().mockResolvedValue(mutation()),
    batchPageOperations: vi.fn().mockResolvedValue(mutation()),
    replacePageMarkdown: vi.fn().mockResolvedValue(mutation()),
    getDailyPage: vi.fn().mockResolvedValue({ page: page(), created: true, operation: { id: "op-1" } }),
  };
}

function page() {
  return {
    id: "page-1",
    title: "Page",
    daily_date: null,
    version: 1,
    archived: false,
    metadata: {},
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
  };
}

function block(id: string, parentId: string | null, text: string) {
  return {
    id,
    page_id: "page-1",
    parent_id: parentId,
    position_key: "a",
    block_type: "paragraph",
    text,
    properties: {},
    collapsed: false,
  };
}

function mutation() {
  return {
    page: page(),
    blocks: [],
    temp_id_mapping: {},
    operation: { id: "op-1" },
  };
}
