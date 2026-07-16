import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const openClients: Client[] = [];
const openServers: Awaited<ReturnType<typeof buildServer>>[] = [];
const callerSessionIdGuidance =
  "Codex 등 헤더 미지원 백엔드는 자기 agent_session_id를 caller_session_id로 전달한다.";
const runbookMutationToolNames = [
  "create_runbook",
  "update_runbook",
  "set_runbook_status",
  "archive_runbook",
  "unarchive_runbook",
  "create_runbook_section",
  "update_runbook_section",
  "set_runbook_section_assignee",
  "archive_runbook_section",
  "unarchive_runbook_section",
  "move_runbook_section",
  "create_runbook_item",
  "update_runbook_item",
  "set_runbook_item_assignee",
  "archive_runbook_item",
  "unarchive_runbook_item",
  "move_runbook_item",
  "set_runbook_item_status",
] as const;
const runbookReadToolNames = [
  "list_runbooks",
  "get_runbook",
  "list_my_turn_items",
  "list_runbook_operations",
] as const;
const customViewMutationToolNames = [
  "create_custom_view",
  "patch_custom_view",
] as const;
const customViewReadToolNames = [
  "get_custom_view",
  "list_custom_views",
] as const;

function createSilentLogger() {
  const noop = () => {};
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => createSilentLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(
  params: {
    catalogService?: Record<string, unknown>;
    runbookService?: Record<string, unknown>;
    runbookTaskIdentityHostClient?: Record<string, unknown>;
    customViewService?: Record<string, unknown>;
  } = {},
): McpRuntime {
  return {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {} as SessionDB,
    taskManager: {
      listTasks: vi.fn(() => []),
      getTask: vi.fn(() => undefined),
    } as unknown as TaskManager,
    taskExecutor: {} as TaskExecutor,
    agentRegistry: new AgentRegistry([]),
    catalogService: (params.catalogService ?? {}) as CatalogService,
    runbookService: params.runbookService as never,
    runbookTaskIdentityHostClient:
      params.runbookTaskIdentityHostClient as never,
    customViewService: params.customViewService as never,
    logger: createSilentLogger(),
  };
}

async function createClient(
  runtime: McpRuntime,
  headers?: Record<string, string>,
): Promise<Client> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: runtime.nodeId,
    logger: createSilentLogger(),
    mcp: {
      runtime,
      path: "/mcp",
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    },
  });
  openServers.push(server);
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "runbook-mcp-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp`),
      headers ? { requestInit: { headers } } : undefined,
    ),
  );
  openClients.push(client);
  return client;
}

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    try {
      await client?.close();
    } catch {
      // ignore cleanup failures
    }
  }
  while (openServers.length > 0) {
    const server = openServers.pop();
    try {
      if (server?.closeMcp) await server.closeMcp();
      await server?.close();
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("runbook MCP tools", () => {
  it("exposes runbook tools", async () => {
    const client = await createClient(
      makeRuntime({ runbookService: fakeRunbookService() }),
    );

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "create_runbook",
        "list_runbooks",
        "update_runbook",
        "set_runbook_status",
        "archive_runbook",
        "unarchive_runbook",
        "create_runbook_section",
        "update_runbook_section",
        "set_runbook_section_assignee",
        "archive_runbook_section",
        "unarchive_runbook_section",
        "move_runbook_section",
        "create_runbook_item",
        "update_runbook_item",
        "set_runbook_item_assignee",
        "archive_runbook_item",
        "unarchive_runbook_item",
        "move_runbook_item",
        "set_runbook_item_status",
        "get_runbook",
        "list_my_turn_items",
        "list_runbook_operations",
      ]),
    );
    for (const name of runbookMutationToolNames) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(JSON.stringify(tool?.inputSchema)).toContain("caller_session_id");
      expect(JSON.stringify(tool?.inputSchema)).toContain("include_snapshot");
      expect(tool?.description ?? "").toContain(callerSessionIdGuidance);
    }
    for (const name of runbookReadToolNames) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(JSON.stringify(tool?.inputSchema)).not.toContain(
        "caller_session_id",
      );
      expect(tool?.description ?? "").not.toContain(callerSessionIdGuidance);
    }
  });

  it("moves board items between board containers through the catalog MCP tool", async () => {
    const catalogService = {
      moveBoardItemToContainer: vi.fn(async () => ({
        boardItem: {
          id: "markdown:doc-1",
          folderId: "folder-1",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "markdown",
          itemId: "doc-1",
          x: 120,
          y: 240,
          metadata: { title: "Note" },
        },
        enrolled: false,
      })),
    };
    const client = await createClient(makeRuntime({ catalogService }));

    const result = await client.callTool({
      name: "move_board_item_to_container",
      arguments: {
        board_item_id: "markdown:doc-1",
        container: { kind: "runbook", id: "rb-1" },
        x: 121,
        y: 239,
        idempotency_key: "move-1",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      idempotency_key: "move-1",
      board_item: {
        id: "markdown:doc-1",
        containerKind: "runbook",
        containerId: "rb-1",
      },
    });
    expect(catalogService.moveBoardItemToContainer).toHaveBeenCalledWith({
      boardItemId: "markdown:doc-1",
      target: { containerKind: "runbook", containerId: "rb-1" },
      position: { x: 121, y: 239 },
      idempotencyKey: "move-1",
    });
  });

  it("uses caller session header as actor_kind='agent' for mutations", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "set_runbook_item_status",
      arguments: {
        item_id: "item-1",
        status: "completed",
        expected_version: 3,
        idempotency_key: "idem-status-1",
        reason: "done",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      operation: {
        target_kind: "item",
        target_id: "item-1",
      },
      target: {
        kind: "item",
        row: {
          id: "item-1",
          how_to: "Do the thing",
          version: 4,
        },
      },
      runbook: {
        id: "rb-1",
        version: 7,
        updated_at: "2026-07-16T00:00:00.000Z",
      },
    });
    expect(result.structuredContent).not.toHaveProperty("snapshot");
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      itemId: "item-1",
      status: "completed",
      expectedVersion: 3,
      reason: "done",
      idempotencyKey: "idem-status-1",
    });
  });

  it("returns the unchanged mutation result when include_snapshot is true", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "set_runbook_item_status",
      arguments: {
        item_id: "item-1",
        status: "completed",
        expected_version: 3,
        idempotency_key: "idem-status-full-1",
        include_snapshot: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      snapshot: {
        runbook: { id: "rb-1" },
        sections: [{ id: "sec-1" }],
        items: [{ id: "item-1", version: 4 }],
      },
      operation: { id: "op-item" },
      eventId: 1,
    });
    expect(result.structuredContent).not.toHaveProperty("target");
  });

  it("returns the changed section and runbook rows in slim mutation responses", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const sectionResult = await client.callTool({
      name: "update_runbook_section",
      arguments: {
        runbook_id: "rb-1",
        section_id: "sec-1",
        expected_version: 2,
        title: "Updated section",
        idempotency_key: "idem-section-slim-1",
      },
    });
    const runbookResult = await client.callTool({
      name: "set_runbook_status",
      arguments: {
        runbook_id: "rb-1",
        status: "completed",
        expected_version: 6,
        idempotency_key: "idem-runbook-slim-1",
      },
    });

    expect(sectionResult.structuredContent).toMatchObject({
      target: { kind: "section", row: { id: "sec-1", version: 3 } },
      runbook: { id: "rb-1", version: 7 },
    });
    expect(runbookResult.structuredContent).toMatchObject({
      target: { kind: "runbook", row: { id: "rb-1", version: 7 } },
      runbook: { id: "rb-1", version: 7 },
    });
  });

  it("keeps get_runbook full by default and supports outline and item views", async () => {
    const service = fakeRunbookService();
    const client = await createClient(makeRuntime({ runbookService: service }));

    const full = await client.callTool({
      name: "get_runbook",
      arguments: { runbook_id: "rb-1" },
    });
    const outline = await client.callTool({
      name: "get_runbook",
      arguments: { runbook_id: "rb-1", view: "outline" },
    });
    const item = await client.callTool({
      name: "get_runbook",
      arguments: { runbook_id: "rb-1", item_id: "item-1" },
    });

    expect(full.structuredContent).toMatchObject({
      runbook: { id: "rb-1" },
      sections: [{ id: "sec-1" }],
      items: [{ id: "item-1", how_to: "Do the thing" }],
    });
    expect(outline.structuredContent).toEqual({
      runbook: {
        id: "rb-1",
        title: "Runbook",
        status: "open",
        version: 7,
        updated_at: "2026-07-16T00:00:00.000Z",
      },
      sections: [
        {
          id: "sec-1",
          title: "Section",
          version: 3,
          assignee: null,
          items: [
            {
              id: "item-1",
              title: "Item",
              status: "in_progress",
              version: 4,
              assignee: { kind: "agent", agent_id: "roselin" },
            },
          ],
        },
      ],
    });
    expect(item.structuredContent).toMatchObject({
      runbook: { id: "rb-1", version: 7 },
      section: { id: "sec-1", version: 3 },
      item: { id: "item-1", how_to: "Do the thing", version: 4 },
    });
    expect(item.structuredContent).not.toHaveProperty("sections");
    expect(item.structuredContent).not.toHaveProperty("items");
  });

  it("uses explicit caller_session_id for runbook mutations without a header", async () => {
    const service = fakeRunbookService();
    const client = await createClient(makeRuntime({ runbookService: service }));

    const result = await client.callTool({
      name: "set_runbook_item_status",
      arguments: {
        item_id: "item-1",
        status: "completed",
        expected_version: 3,
        idempotency_key: "idem-status-explicit",
        reason: "done",
        caller_session_id: "sess-explicit",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-explicit",
      itemId: "item-1",
      status: "completed",
      expectedVersion: 3,
      reason: "done",
      idempotencyKey: "idem-status-explicit",
    });
  });

  it("prefers explicit caller_session_id over the caller session header", async () => {
    const service = fakeRunbookService();
    const taskIdentityHost = fakeTaskIdentityHost();
    const client = await createClient(
      makeRuntime({
        runbookService: service,
        runbookTaskIdentityHostClient: taskIdentityHost,
      }),
      { "x-soulstream-agent-session-id": "sess-header" },
    );

    const result = await client.callTool({
      name: "update_runbook",
      arguments: {
        runbook_id: "rb-1",
        expected_version: 3,
        title: "Explicit caller wins",
        idempotency_key: "idem-runbook-explicit-wins",
        caller_session_id: "sess-explicit",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(taskIdentityHost.update).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-explicit",
      runbookId: "rb-1",
      expectedVersion: 3,
      title: "Explicit caller wins",
      reason: undefined,
      idempotencyKey: "idem-runbook-explicit-wins",
    });
  });

  it("accepts review as an item status through MCP", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "set_runbook_item_status",
      arguments: {
        item_id: "item-1",
        status: "review",
        expected_version: 3,
        idempotency_key: "idem-status-review-1",
        reason: "ready for review",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.setItemStatus).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      itemId: "item-1",
      status: "review",
      expectedVersion: 3,
      reason: "ready for review",
      idempotencyKey: "idem-status-review-1",
    });
  });

  it("routes runbook-level status changes through the dedicated object tool", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "set_runbook_status",
      arguments: {
        runbook_id: "rb-1",
        status: "completed",
        expected_version: 7,
        idempotency_key: "idem-runbook-status-1",
        reason: "done",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.setRunbookStatus).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      runbookId: "rb-1",
      status: "completed",
      expectedVersion: 7,
      reason: "done",
      idempotencyKey: "idem-runbook-status-1",
    });
  });

  it("creates runbooks through folder-scoped board item input", async () => {
    const service = fakeRunbookService();
    const taskIdentityHost = fakeTaskIdentityHost();
    const client = await createClient(
      makeRuntime({
        runbookService: service,
        runbookTaskIdentityHostClient: taskIdentityHost,
      }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "create_runbook",
      arguments: {
        folder_id: "folder-1",
        title: "Launch runbook",
        x: 120,
        y: 240,
        runbook_id: "00000000-0000-4000-8000-0000000000ae",
        idempotency_key: "idem-create-1",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      operation: { id: "op-identity", target_kind: "runbook" },
      target: { kind: "runbook", row: { id: "rb-1", version: 7 } },
      runbook: { id: "rb-1", version: 7 },
    });
    expect(result.structuredContent).not.toHaveProperty("snapshot");
    expect(taskIdentityHost.create).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      folderId: "folder-1",
      title: "Launch runbook",
      x: 120,
      y: 240,
      runbookId: "00000000-0000-4000-8000-0000000000ae",
      idempotencyKey: "idem-create-1",
    });
  });

  it("lists runbooks by folder without requiring a caller session", async () => {
    const service = fakeRunbookService();
    const client = await createClient(makeRuntime({ runbookService: service }));

    const result = await client.callTool({
      name: "list_runbooks",
      arguments: {
        folder_id: "folder-1",
        include_archived: true,
        limit: 25,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.listRunbooks).toHaveBeenCalledWith({
      folderId: "folder-1",
      includeArchived: true,
      limit: 25,
    });
  });

  it("routes runbook archive symmetry through explicit tools", async () => {
    const service = fakeRunbookService();
    const taskIdentityHost = fakeTaskIdentityHost();
    const client = await createClient(
      makeRuntime({
        runbookService: service,
        runbookTaskIdentityHostClient: taskIdentityHost,
      }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    await client.callTool({
      name: "archive_runbook",
      arguments: {
        runbook_id: "rb-1",
        expected_version: 2,
        idempotency_key: "idem-archive-runbook",
      },
    });
    await client.callTool({
      name: "unarchive_runbook",
      arguments: {
        runbook_id: "rb-1",
        expected_version: 3,
        reason: "restore",
        idempotency_key: "idem-unarchive-runbook",
      },
    });

    expect(taskIdentityHost.update).toHaveBeenNthCalledWith(1, {
      actorKind: "agent",
      actorSessionId: "sess-caller",
      runbookId: "rb-1",
      expectedVersion: 2,
      archived: true,
      reason: undefined,
      idempotencyKey: "idem-archive-runbook",
    });
    expect(taskIdentityHost.update).toHaveBeenNthCalledWith(2, {
      actorKind: "agent",
      actorSessionId: "sess-caller",
      runbookId: "rb-1",
      expectedVersion: 3,
      archived: false,
      reason: "restore",
      idempotencyKey: "idem-unarchive-runbook",
    });
  });

  it("routes assignee changes through dedicated section and item tools", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    await client.callTool({
      name: "set_runbook_section_assignee",
      arguments: {
        runbook_id: "rb-1",
        section_id: "sec-1",
        expected_version: 4,
        assignee: { kind: "agent", agent_id: "roselin" },
        idempotency_key: "idem-section-assignee",
      },
    });
    await client.callTool({
      name: "set_runbook_item_assignee",
      arguments: {
        runbook_id: "rb-1",
        item_id: "item-1",
        expected_version: 5,
        assignee: null,
        reason: "inherit section",
        idempotency_key: "idem-item-assignee",
      },
    });

    expect(service.setSectionAssignee).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      runbookId: "rb-1",
      sectionId: "sec-1",
      expectedVersion: 4,
      assignee: {
        kind: "agent",
        agentId: "roselin",
        sessionId: undefined,
        userId: undefined,
      },
      reason: undefined,
      idempotencyKey: "idem-section-assignee",
    });
    expect(service.setItemAssignee).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      runbookId: "rb-1",
      itemId: "item-1",
      expectedVersion: 5,
      assignee: null,
      reason: "inherit section",
      idempotencyKey: "idem-item-assignee",
    });
  });

  it("rejects mutation calls without caller session header", async () => {
    const service = fakeRunbookService();
    const client = await createClient(makeRuntime({ runbookService: service }));

    const result = await client.callTool({
      name: "create_runbook",
      arguments: {
        folder_id: "folder-1",
        title: "Runbook",
        idempotency_key: "idem-create-1",
      },
    });

    expect(result.isError).toBe(true);
    expect(service.createRunbook).not.toHaveBeenCalled();
  });
});

describe("custom view MCP tools", () => {
  it("exposes custom view tools", async () => {
    const client = await createClient(
      makeRuntime({ customViewService: fakeCustomViewService() }),
    );

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "create_custom_view",
        "patch_custom_view",
        "get_custom_view",
        "list_custom_views",
      ]),
    );
    for (const name of customViewMutationToolNames) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(JSON.stringify(tool?.inputSchema)).toContain("caller_session_id");
      expect(tool?.description ?? "").toContain(callerSessionIdGuidance);
    }
    for (const name of customViewReadToolNames) {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      expect(JSON.stringify(tool?.inputSchema)).not.toContain(
        "caller_session_id",
      );
      expect(tool?.description ?? "").not.toContain(callerSessionIdGuidance);
    }
  });

  it("creates custom views with container input and caller session actor", async () => {
    const service = fakeCustomViewService();
    const client = await createClient(
      makeRuntime({ customViewService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "create_custom_view",
      arguments: {
        container: { kind: "runbook", id: "rb-1" },
        title: "Progress panel",
        html: "<section></section>",
        x: 120,
        y: 240,
        idempotency_key: "idem-custom-create",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.createCustomView).toHaveBeenCalledWith({
      actorSessionId: "sess-caller",
      container: { containerKind: "runbook", containerId: "rb-1" },
      title: "Progress panel",
      html: "<section></section>",
      x: 120,
      y: 240,
      idempotencyKey: "idem-custom-create",
    });
  });

  it("patches custom views with revision CAS input", async () => {
    const service = fakeCustomViewService();
    const client = await createClient(
      makeRuntime({ customViewService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "patch_custom_view",
      arguments: {
        custom_view_id: "cv-1",
        expected_revision: 3,
        title: "Progress panel v2",
        html: "<main></main>",
        idempotency_key: "idem-custom-patch",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.patchCustomView).toHaveBeenCalledWith({
      actorSessionId: "sess-caller",
      customViewId: "cv-1",
      expectedRevision: 3,
      title: "Progress panel v2",
      html: "<main></main>",
      idempotencyKey: "idem-custom-patch",
    });
  });

  it("uses explicit caller_session_id for custom view mutations without a header", async () => {
    const service = fakeCustomViewService();
    const client = await createClient(
      makeRuntime({ customViewService: service }),
    );

    const result = await client.callTool({
      name: "create_custom_view",
      arguments: {
        container: { kind: "runbook", id: "rb-1" },
        title: "Progress panel",
        html: "<section></section>",
        x: 120,
        y: 240,
        idempotency_key: "idem-custom-explicit",
        caller_session_id: "sess-explicit",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.createCustomView).toHaveBeenCalledWith({
      actorSessionId: "sess-explicit",
      container: { containerKind: "runbook", containerId: "rb-1" },
      title: "Progress panel",
      html: "<section></section>",
      x: 120,
      y: 240,
      idempotencyKey: "idem-custom-explicit",
    });
  });

  it("prefers explicit caller_session_id over the caller session header for custom view mutations", async () => {
    const service = fakeCustomViewService();
    const client = await createClient(
      makeRuntime({ customViewService: service }),
      { "x-soulstream-agent-session-id": "sess-header" },
    );

    const result = await client.callTool({
      name: "patch_custom_view",
      arguments: {
        custom_view_id: "cv-1",
        expected_revision: 3,
        title: "Progress panel v2",
        html: "<main></main>",
        idempotency_key: "idem-custom-explicit-wins",
        caller_session_id: "sess-explicit",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.patchCustomView).toHaveBeenCalledWith({
      actorSessionId: "sess-explicit",
      customViewId: "cv-1",
      expectedRevision: 3,
      title: "Progress panel v2",
      html: "<main></main>",
      idempotencyKey: "idem-custom-explicit-wins",
    });
  });

  it("rejects custom view mutations without caller session header", async () => {
    const service = fakeCustomViewService();
    const client = await createClient(
      makeRuntime({ customViewService: service }),
    );

    const result = await client.callTool({
      name: "create_custom_view",
      arguments: {
        container: { kind: "folder", id: "folder-1" },
        html: "<section></section>",
        idempotency_key: "idem-custom-create",
      },
    });

    expect(result.isError).toBe(true);
    expect(service.createCustomView).not.toHaveBeenCalled();
  });
});

function fakeRunbookService() {
  const snapshot = fakeRunbookSnapshot();
  const mutationResult = (
    targetKind: "runbook" | "section" | "item",
    targetId: string,
  ) => ({
    snapshot,
    operation: {
      id: `op-${targetKind}`,
      runbook_id: "rb-1",
      target_kind: targetKind,
      target_id: targetId,
    },
    eventId: 1,
  });
  return {
    createRunbook: vi.fn(async () => mutationResult("runbook", "rb-1")),
    listRunbooks: vi.fn(async () => []),
    patchRunbook: vi.fn(async () => mutationResult("runbook", "rb-1")),
    setRunbookStatus: vi.fn(async () => mutationResult("runbook", "rb-1")),
    createSection: vi.fn(async () => mutationResult("section", "sec-1")),
    patchSection: vi.fn(async () => mutationResult("section", "sec-1")),
    setSectionAssignee: vi.fn(async () => mutationResult("section", "sec-1")),
    moveSection: vi.fn(async () => mutationResult("section", "sec-1")),
    createItem: vi.fn(async () => mutationResult("item", "item-1")),
    patchItem: vi.fn(async () => mutationResult("item", "item-1")),
    setItemAssignee: vi.fn(async () => mutationResult("item", "item-1")),
    moveItem: vi.fn(async () => mutationResult("item", "item-1")),
    setItemStatus: vi.fn(async () => mutationResult("item", "item-1")),
    getRunbook: vi.fn(async () => snapshot),
    listMyTurnItems: vi.fn(async () => []),
    listOperations: vi.fn(async () => []),
  };
}

function fakeTaskIdentityHost() {
  const snapshot = fakeRunbookSnapshot();
  const result = {
    id: "00000000-0000-4000-8000-0000000000ae",
    pageId: "00000000-0000-4000-8000-0000000000ae",
    runbookId: "00000000-0000-4000-8000-0000000000ae",
    snapshot,
    operation: {
      id: "op-identity",
      runbook_id: "rb-1",
      target_kind: "runbook",
      target_id: "rb-1",
    },
    pageOperation: { id: "op-page" },
  };
  return {
    create: vi.fn(async () => result),
    update: vi.fn(async () => result),
    promoteExistingPage: vi.fn(async () => result),
  };
}

function fakeRunbookSnapshot() {
  return {
    runbook: {
      id: "rb-1",
      board_item_id: "runbook:rb-1",
      title: "Runbook",
      status: "open",
      archived: false,
      version: 7,
      created_session_id: "sess-caller",
      created_event_id: 1,
      completed_kind: null,
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: null,
      created_at: new Date("2026-07-15T00:00:00.000Z"),
      updated_at: new Date("2026-07-16T00:00:00.000Z"),
    },
    sections: [
      {
        id: "sec-1",
        runbook_id: "rb-1",
        position_key: "V",
        title: "Section",
        assignee_kind: null,
        assignee_agent_id: null,
        assignee_session_id: null,
        assignee_user_id: null,
        archived: false,
        version: 3,
        created_session_id: "sess-caller",
        created_event_id: 2,
        updated_session_id: "sess-caller",
        updated_event_id: 3,
        created_at: new Date("2026-07-15T00:00:00.000Z"),
        updated_at: new Date("2026-07-16T00:00:00.000Z"),
      },
    ],
    items: [
      {
        id: "item-1",
        section_id: "sec-1",
        position_key: "V",
        title: "Item",
        how_to: "Do the thing",
        status: "in_progress",
        assignee_kind: "agent",
        assignee_agent_id: "roselin",
        assignee_session_id: null,
        assignee_user_id: null,
        archived: false,
        version: 4,
        created_session_id: "sess-caller",
        created_event_id: 4,
        updated_session_id: "sess-caller",
        updated_event_id: 5,
        completed_kind: null,
        completed_session_id: null,
        completed_event_id: null,
        completed_user_id: null,
        completed_at: null,
        created_at: new Date("2026-07-15T00:00:00.000Z"),
        updated_at: new Date("2026-07-16T00:00:00.000Z"),
      },
    ],
  };
}

function fakeCustomViewService() {
  const result = {
    customView: {
      id: "cv-1",
      boardItemId: "custom_view:cv-1",
      title: "Progress panel",
      html: "<section></section>",
      revision: 1,
    },
    boardItem: {
      id: "custom_view:cv-1",
      folderId: "folder-1",
      itemType: "custom_view",
      itemId: "cv-1",
      x: 120,
      y: 240,
      metadata: {},
    },
  };
  return {
    createCustomView: vi.fn(async () => result),
    patchCustomView: vi.fn(async () => ({
      ...result,
      customView: { ...result.customView, revision: 4 },
    })),
    getCustomView: vi.fn(async () => result),
    listCustomViews: vi.fn(async () => [result]),
  };
}
