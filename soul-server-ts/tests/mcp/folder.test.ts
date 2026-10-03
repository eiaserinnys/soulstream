import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import * as persistenceHostTransport from "../../src/control_plane/persistence_host_transport.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { FolderService } from "../../src/folder/folder_service.js";
import { jsonResult } from "../../src/mcp/result.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildInternalMcpServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const openClients: Client[] = [];
const openServers: Awaited<ReturnType<typeof buildInternalMcpServer>>[] = [];

const mutationNames = [
  "create_folder", "rename_folder", "archive_folder", "unarchive_folder",
  "set_folder_status",
];
const readNames = ["list_child_folders", "get_folder", "list_folder_operations"];

function logger() {
  const noop = () => {};
  return { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop,
    silent: noop, level: "silent", child: logger } as unknown as McpRuntime["logger"];
}

function runtime(folderService?: Partial<FolderService>, catalogService?: Partial<CatalogService>): McpRuntime {
  return {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {} as SessionDB,
    taskManager: { listTasks: vi.fn(() => []), getTask: vi.fn(() => undefined) } as unknown as TaskManager,
    taskExecutor: {} as TaskExecutor,
    onResume: () => undefined,
    agentRegistry: new AgentRegistry([]),
    catalogService: (catalogService ?? {}) as CatalogService,
    logger: logger(),
    orch: { baseUrl: "http://orch.test", headers: { authorization: "Bearer service-token" } },
  };
}

async function clientFor(source: McpRuntime, headers?: Record<string, string>): Promise<Client> {
  const server = await buildInternalMcpServer({
    logger: logger(), runtime: source, path: "/mcp/internal",
    auth: { requireAuth: false, bearerToken: "", allowedHosts: ["127.0.0.1", "localhost"] },
    statelessTransport: true,
  });
  openServers.push(server);
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "folder-mcp-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/internal`),
    headers ? { requestInit: { headers } } : undefined));
  openClients.push(client);
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (openClients.length) {
    try { await openClients.pop()?.close(); } catch { /* cleanup */ }
  }
  while (openServers.length) {
    const server = openServers.pop();
    try { if (server?.closeMcp) await server.closeMcp(); await server?.close(); } catch { /* cleanup */ }
  }
});

const snapshot = {
  folder: { id: "folder-1", name: "Work", status: "open", version: 4 },
  cards: [{ id: "card-1", folderId: "folder-1", title: "Card", request: "Do the thing", status: "done", version: 3 }],
};

describe("folder and checklist MCP contract", () => {
  it("registers every folder/checklist tool once and removes vessel aliases", async () => {
    const client = await clientFor(runtime());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...mutationNames, ...readNames,
      "browse_folder", "search_folder_items", "move_board_item_to_folder"]));
    for (const name of [...mutationNames, ...readNames]) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
    }
    expect(names.filter((name) => name.startsWith("create_task") || name.startsWith("get_task") ||
      name.startsWith("list_task") || name.includes("runbook") || name.includes("container"))).toEqual([]);
    const tools = (await client.listTools()).tools;
    for (const name of mutationNames) {
      const schema = JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema);
      expect(schema).toContain("caller_session_id");
      expect(schema).not.toContain("include_snapshot");
      expect(schema).not.toContain("task_id");
      expect(schema).not.toContain("container");
    }
  });

  it("returns folder snapshots with full, outline, and item views", async () => {
    const forwarded = vi.spyOn(persistenceHostTransport, "fetchOrchResponse").mockImplementation(async () =>
      new Response(JSON.stringify(jsonResult(snapshot)), { status: 200 }));
    const client = await clientFor(runtime());
    const full = await client.callTool({ name: "get_folder", arguments: { folder_id: "folder-1" } });
    const outline = await client.callTool({ name: "get_folder", arguments: {
      folder_id: "folder-1", view: "outline",
    } });
    const item = await client.callTool({ name: "get_folder", arguments: {
      folder_id: "folder-1", card_id: "card-1",
    } });
    const paged = await client.callTool({ name: "get_folder", arguments: {
      folder_id: "folder-1", view: "outline", include_archived: true, limit: 7, cursor: "14",
    } });
    expect(paged.isError).not.toBe(true);
    expect(full.structuredContent).toMatchObject({ folder: { id: "folder-1" }, cards: [{ request: "Do the thing" }] });
    expect(outline.structuredContent).toMatchObject({ folder: { id: "folder-1" }, cards: [{ id: "card-1" }] });
    expect(item.structuredContent).toMatchObject({ cards: [{ id: "card-1" }] });
    expect(forwarded).toHaveBeenCalledTimes(4);
    const bodies = forwarded.mock.calls.map(([, , , body]) => body as { args: unknown; context: unknown });
    expect(bodies[1].args).toEqual({ folder_id: "folder-1", view: "outline" });
    expect(bodies[2].args).toEqual({ folder_id: "folder-1", view: "full", card_id: "card-1" });
    expect(bodies[3].args).toEqual({ folder_id: "folder-1", view: "outline", include_archived: true, limit: 7, cursor: "14" });
    expect(bodies[0].context).toEqual({ principal: "internal", caller_session_id: null, node_id: "node-test" });
    expect(forwarded.mock.calls[0]?.[2]).toBe("/api/mcp/host/get_folder");

  });

  it("forwards SDK defaults when listing root folders", async () => {
    const forwarded = vi.spyOn(persistenceHostTransport, "fetchOrchResponse").mockResolvedValue(
      new Response(JSON.stringify(jsonResult({ items: [{ id: "folder-1" }], nextCursor: null })), { status: 200 }));
    const client = await clientFor(runtime());
    const result = await client.callTool({ name: "list_child_folders", arguments: { cursor: "20" } });
    expect(result.isError).not.toBe(true);
    expect((forwarded.mock.calls[0]?.[3] as { args: unknown }).args)
      .toEqual({ include_archived: false, limit: 100, cursor: "20" });
  });

  it("moves board items and creates markdown with one folder_id", async () => {
    const forwarded = vi.spyOn(persistenceHostTransport, "fetchOrchResponse").mockImplementation(async () =>
      new Response(JSON.stringify(jsonResult({ ok: true })), { status: 200 }));
    const client = await clientFor(runtime());
    for (const [name, args] of [
      ["move_board_item_to_folder", { board_item_id: "markdown:doc-1", folder_id: "folder-1", idempotency_key: "move-1" }],
      ["create_markdown_document", { folder_id: "folder-1", title: "Note", body: "Text" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(forwarded.mock.calls.at(-1)?.[2]).toBe(`/api/mcp/host/${name}`);
      expect((forwarded.mock.calls.at(-1)?.[3] as { args: unknown }).args).toEqual(args);
    }
  });
});
