import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildInternalMcpServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { FolderService } from "../../src/work-task/task_service.js";

const openClients: Client[] = [];
const openServers: Awaited<ReturnType<typeof buildInternalMcpServer>>[] = [];

const mutationNames = [
  "create_folder", "rename_folder", "archive_folder", "unarchive_folder",
  "set_folder_status", "set_folder_checklist_enabled",
  "create_checklist_section", "update_checklist_section", "set_checklist_section_assignee",
  "archive_checklist_section", "unarchive_checklist_section", "move_checklist_section",
  "create_checklist_item", "update_checklist_item", "set_checklist_item_assignee",
  "archive_checklist_item", "unarchive_checklist_item", "move_checklist_item",
  "set_checklist_item_status",
];
const readNames = ["list_child_folders", "get_folder", "list_folder_operations", "list_my_turn_items"];

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
    folderService: folderService as FolderService,
    logger: logger(),
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
  while (openClients.length) {
    try { await openClients.pop()?.close(); } catch { /* cleanup */ }
  }
  while (openServers.length) {
    const server = openServers.pop();
    try { if (server?.closeMcp) await server.closeMcp(); await server?.close(); } catch { /* cleanup */ }
  }
});

const snapshot = {
  folder: { id: "folder-1", name: "Work", checklist_enabled: true, status: "open", version: 4 },
  sections: [{ id: "section-1", folder_id: "folder-1", title: "Section", version: 2 }],
  items: [{ id: "item-1", folder_id: "folder-1", section_id: "section-1", title: "Item",
    how_to: "Do the thing", status: "completed", version: 3 }],
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
      expect(schema).toContain("include_snapshot");
      expect(schema).not.toContain("task_id");
      expect(schema).not.toContain("container");
    }
  });

  it("passes folder_id and the caller session to checklist mutation", async () => {
    const setChecklistItemStatus = vi.fn(async () => ({
      snapshot,
      operation: { id: "op-1", target_kind: "item", target_id: "item-1" },
      eventId: 3,
    }));
    const client = await clientFor(runtime({ setChecklistItemStatus }),
      { "x-soulstream-agent-session-id": "caller-1" });
    const result = await client.callTool({ name: "set_checklist_item_status", arguments: {
      folder_id: "folder-1", item_id: "item-1", status: "completed",
      expected_version: 2, idempotency_key: "status-1",
    } });
    expect(result.isError).not.toBe(true);
    expect(setChecklistItemStatus).toHaveBeenCalledWith(expect.objectContaining({
      actorKind: "agent", actorSessionId: "caller-1", folderId: "folder-1",
      itemId: "item-1", status: "completed", expectedVersion: 2,
    }));
    expect(result.structuredContent).toMatchObject({
      operation: { target_id: "item-1" }, target: { kind: "item", row: { id: "item-1" } },
      folder: { id: "folder-1", version: 4 },
    });
  });

  it("returns folder snapshots with full, outline, and item views", async () => {
    const getFolder = vi.fn(async () => snapshot);
    const client = await clientFor(runtime({ getFolder }));
    const full = await client.callTool({ name: "get_folder", arguments: { folder_id: "folder-1" } });
    const outline = await client.callTool({ name: "get_folder", arguments: {
      folder_id: "folder-1", view: "outline",
    } });
    const item = await client.callTool({ name: "get_folder", arguments: {
      folder_id: "folder-1", item_id: "item-1",
    } });
    expect(full.structuredContent).toMatchObject({ folder: { id: "folder-1" }, items: [{ how_to: "Do the thing" }] });
    expect(outline.structuredContent).toMatchObject({ folder: { checklist_enabled: true }, sections: [{ items: [{ id: "item-1" }] }] });
    expect(JSON.stringify(outline.structuredContent)).not.toContain("Do the thing");
    expect(item.structuredContent).toMatchObject({ item: { id: "item-1" }, section: { id: "section-1" } });
    expect(getFolder).toHaveBeenCalledTimes(3);
  });

  it("moves board items and creates markdown with one folder_id", async () => {
    const moveBoardItemToFolder = vi.fn(async () => ({
      boardItem: { id: "markdown:doc-1", folderId: "folder-1" }, enrolled: false,
    }));
    const createMarkdownDocument = vi.fn(async () => ({ document: { id: "doc-2" }, boardItem: { id: "markdown:doc-2" } }));
    const client = await clientFor(runtime(undefined, { moveBoardItemToFolder, createMarkdownDocument }));
    const moved = await client.callTool({ name: "move_board_item_to_folder", arguments: {
      board_item_id: "markdown:doc-1", folder_id: "folder-1", idempotency_key: "move-1",
    } });
    const created = await client.callTool({ name: "create_markdown_document", arguments: {
      folder_id: "folder-1", title: "Note", body: "Text",
    } });
    expect(moved.isError).not.toBe(true);
    expect(created.isError).not.toBe(true);
    expect(moveBoardItemToFolder).toHaveBeenCalledWith({
      boardItemId: "markdown:doc-1", folderId: "folder-1", idempotencyKey: "move-1",
    });
    expect(createMarkdownDocument).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-1", title: "Note", body: "Text" }));
  });
});
