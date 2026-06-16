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

function makeRuntime(params: {
  runbookEnabled?: boolean;
  runbookService?: Record<string, unknown>;
} = {}): McpRuntime {
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
    catalogService: {} as CatalogService,
    runbookEnabled: params.runbookEnabled ?? false,
    runbookService: params.runbookService as never,
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
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    headers ? { requestInit: { headers } } : undefined,
  ));
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
  it("hides runbook tools while RUNBOOK_ENABLED is false", async () => {
    const client = await createClient(makeRuntime());

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).not.toContain("create_runbook");
  });

  it("exposes runbook tools while RUNBOOK_ENABLED is true", async () => {
    const client = await createClient(
      makeRuntime({ runbookEnabled: true, runbookService: fakeRunbookService() }),
    );

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      "create_runbook",
      "create_runbook_section",
      "move_runbook_item",
      "set_runbook_item_status",
      "get_runbook",
      "list_my_turn_items",
      "list_runbook_operations",
    ]));
  });

  it("uses caller session header as actor_kind='agent' for mutations", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookEnabled: true, runbookService: service }),
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

  it("creates runbooks through folder-scoped board item input", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookEnabled: true, runbookService: service }),
      { "x-soulstream-agent-session-id": "sess-caller" },
    );

    const result = await client.callTool({
      name: "create_runbook",
      arguments: {
        folder_id: "folder-1",
        title: "Launch runbook",
        x: 120,
        y: 240,
        runbook_id: "rb-1",
        idempotency_key: "idem-create-1",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(service.createRunbook).toHaveBeenCalledWith({
      actorKind: "agent",
      actorSessionId: "sess-caller",
      folderId: "folder-1",
      title: "Launch runbook",
      x: 120,
      y: 240,
      runbookId: "rb-1",
      idempotencyKey: "idem-create-1",
    });
  });

  it("rejects mutation calls without caller session header", async () => {
    const service = fakeRunbookService();
    const client = await createClient(
      makeRuntime({ runbookEnabled: true, runbookService: service }),
    );

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

function fakeRunbookService() {
  const mutationResult = {
    snapshot: {
      runbook: { id: "rb-1", board_item_id: "runbook:rb-1" },
      sections: [],
      items: [],
    },
    operation: { id: "op-1" },
    eventId: 1,
  };
  return {
    createRunbook: vi.fn(async () => mutationResult),
    createSection: vi.fn(async () => mutationResult),
    patchSection: vi.fn(async () => mutationResult),
    moveSection: vi.fn(async () => mutationResult),
    createItem: vi.fn(async () => mutationResult),
    patchItem: vi.fn(async () => mutationResult),
    moveItem: vi.fn(async () => mutationResult),
    setItemStatus: vi.fn(async () => mutationResult),
    getRunbook: vi.fn(async () => mutationResult.snapshot),
    listMyTurnItems: vi.fn(async () => []),
    listOperations: vi.fn(async () => []),
  };
}
