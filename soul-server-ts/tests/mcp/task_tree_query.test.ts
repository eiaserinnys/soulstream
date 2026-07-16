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
import type {
  TaskItemRow,
  TaskOperationRow,
} from "../../src/task_tree/task_tree_repository.js";

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

function makeTask(index: number): TaskItemRow {
  return {
    id: `task-${index}`,
    parent_id: null,
    position_key: index,
    title: `Task ${index}`,
    description: "",
    acceptance_criteria: "",
    verification_owner: "agent",
    status: "open",
    linked_session_id: null,
    linked_node_id: null,
    active_for_session_id: null,
    created_from_session_id: "sess-parent",
    created_from_event_id: null,
    navigation_session_id: null,
    navigation_node_id: null,
    navigation_event_id: null,
    archived: false,
    pinned: false,
    version: 1,
    created_at: new Date("2026-07-16T00:00:00.000Z"),
    updated_at: new Date("2026-07-16T00:00:00.000Z"),
  };
}

function makeOperation(index: number): TaskOperationRow {
  return {
    id: `op-${index}`,
    task_id: "task-1",
    operation_type: "update_task_item",
    actor_kind: "agent",
    actor_session_id: "sess-parent",
    actor_event_id: index,
    actor_user_id: null,
    idempotency_key: null,
    payload_json: {},
    reason: null,
    created_at: new Date("2026-07-16T00:00:00.000Z"),
  };
}

function makeRuntime() {
  const tasks = Array.from({ length: 23 }, (_, index) => makeTask(index + 1));
  const operations = Array.from(
    { length: 45 },
    (_, index) => makeOperation(index + 1),
  );
  const repo = {
    searchTaskItems: vi.fn(async ({ limit }: { limit?: number }) =>
      tasks.slice(0, limit ?? 50),
    ),
    countSearchTaskItems: vi.fn(async () => tasks.length),
    listTaskItems: vi.fn(async ({ limit }: { limit?: number }) =>
      tasks.slice(0, limit ?? 500),
    ),
    countTaskItems: vi.fn(async () => tasks.length),
    getTaskPath: vi.fn(async (taskId: string) => [
      tasks.find((task) => task.id === taskId),
    ].filter(Boolean)),
    listTaskOperations: vi.fn(
      async (_taskId: string, limit = 50, offset = 0) =>
        operations.slice(offset, offset + limit),
    ),
    countTaskOperations: vi.fn(async () => operations.length),
  };
  const runtime: McpRuntime = {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {
      taskTree: () => repo,
    } as unknown as SessionDB,
    taskManager: {
      listTasks: vi.fn(() => []),
      getTask: vi.fn(() => undefined),
    } as unknown as TaskManager,
    taskExecutor: {} as TaskExecutor,
    agentRegistry: new AgentRegistry([]),
    catalogService: {} as CatalogService,
    logger: createSilentLogger(),
  };
  return { runtime, repo };
}

async function createClient(runtime: McpRuntime): Promise<Client> {
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
  const client = new Client({ name: "task-tree-query-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  openClients.push(client);
  return client;
}

afterEach(async () => {
  while (openClients.length > 0) {
    try {
      await openClients.pop()?.close();
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

describe("bounded Task Tree MCP query responses", () => {
  it("defaults search_task_items to 20 and adds exact truncation metadata", async () => {
    const { runtime, repo } = makeRuntime();
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "search_task_items",
      arguments: {},
    });

    expect(repo.searchTaskItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
    expect(result.structuredContent).toMatchObject({
      total: 23,
      returned: 20,
      limit: 20,
      truncated: true,
    });
    expect(result.structuredContent?.result).toHaveLength(20);
    expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "")).toHaveLength(20);
    expect(result.content[1]).toEqual({
      type: "text",
      text: "23건 중 20건 표시. limit을 늘리거나 검색 조건을 좁혀 계속 조회하세요.",
    });
  });

  it("lets an explicit search_task_items limit expand the bounded response", async () => {
    const { runtime, repo } = makeRuntime();
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "search_task_items",
      arguments: { limit: 25 },
    });

    expect(repo.searchTaskItems).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
    expect(result.structuredContent).toMatchObject({
      total: 23,
      returned: 23,
      limit: 25,
      truncated: false,
    });
    expect(result.content).toHaveLength(1);
  });

  it("defaults list_task_operations to 20 with an offset continuation", async () => {
    const { runtime, repo } = makeRuntime();
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "list_task_operations",
      arguments: { task_id: "task-1" },
    });

    expect(repo.listTaskOperations).toHaveBeenCalledWith("task-1", 20, 0);
    expect(result.structuredContent).toMatchObject({
      total: 45,
      returned: 20,
      limit: 20,
      offset: 0,
      truncated: true,
      next_offset: 20,
    });
  });

  it("adds offset continuation to list_task_operations without changing explicit limit", async () => {
    const { runtime, repo } = makeRuntime();
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "list_task_operations",
      arguments: { task_id: "task-1", limit: 5, offset: 10 },
    });

    expect(repo.listTaskOperations).toHaveBeenCalledWith("task-1", 5, 10);
    expect(result.structuredContent).toMatchObject({
      total: 45,
      returned: 5,
      limit: 5,
      offset: 10,
      truncated: true,
      next_offset: 15,
    });
    expect(result.structuredContent?.result).toHaveLength(5);
    expect(result.content[1]).toEqual({
      type: "text",
      text: "45건 중 offset 10부터 5건 표시. offset=15로 계속 조회하세요.",
    });
  });
});
