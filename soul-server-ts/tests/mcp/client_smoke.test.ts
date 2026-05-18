/**
 * SDK Client smoke 테스트 — `@modelcontextprotocol/sdk/client/streamableHttp.js`로 실제 접속.
 *
 * 검증:
 *   - listTools() → 22개 도구 Python 호환 이름 노출
 *   - callTool("reflect_brief") → services 배열
 *   - callTool("list_local_agents") → AgentRegistry 응답
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { AgentRegistry } from "../../src/agent_registry.js";
import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer } from "../../src/server.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const EXPECTED_TOOLS = [
  // reflect
  "reflect_service",
  "reflect_brief",
  "reflect_refresh",
  // session_query
  "list_sessions",
  "list_session_events",
  "get_session_event",
  "download_session_history",
  "search_session_history",
  "get_session_summary",
  // session_mgmt
  "list_local_agents",
  "create_agent_session",
  "send_message_to_session",
  "get_session_name",
  "set_session_name",
  // catalog
  "list_folders",
  "create_folder",
  "rename_folder",
  "delete_folder",
  "move_sessions_to_folder",
  "get_folder_system_prompt",
  "set_folder_system_prompt",
  "delete_session",
  // multi_node
  "list_nodes",
  "list_node_agents",
  "create_remote_agent_session",
];

function createMockSql() {
  const fn = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve([])) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    end: () => Promise<void>;
  };
  fn.array = (a: unknown[]) => a;
  fn.end = vi.fn().mockResolvedValue(undefined);
  return fn as unknown as SqlClient;
}

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

function makeRuntime(): McpRuntime {
  const sql = createMockSql();
  const db = new SessionDB(sql);
  const broadcaster = {
    emitCatalogUpdated: vi.fn().mockResolvedValue(undefined),
    emitSessionDeleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const catalogService = new CatalogService(db, broadcaster);
  const agentRegistry = new AgentRegistry([
    {
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/codex-ws",
      max_turns: 50,
    },
  ]);
  const taskManager = {
    listTasks: () => [],
    getTask: () => undefined,
  } as unknown as TaskManager;
  const taskExecutor = {} as unknown as TaskExecutor;
  return {
    nodeId: "test-node",
    db,
    taskManager,
    taskExecutor,
    agentRegistry,
    catalogService,
    logger: createSilentLogger(),
  };
}

describe("MCP SDK client smoke", () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  let client: Client;
  let url: URL;

  beforeAll(async () => {
    server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger: createSilentLogger(),
      mcp: {
        runtime: makeRuntime(),
        path: "/mcp",
        auth: {
          requireAuth: false,
          bearerToken: "",
          allowedHosts: ["127.0.0.1", "localhost"],
        },
      },
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    url = new URL(`${baseUrl}/mcp`);

    client = new Client({ name: "smoke-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    if (server.closeMcp) await server.closeMcp();
    await server.close();
  });

  it("listTools — Python 호환 이름 22개 모두 노출", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    const expected = [...EXPECTED_TOOLS].sort();
    // 누락 enumerate
    for (const tool of EXPECTED_TOOLS) {
      expect(names).toContain(tool);
    }
    expect(names.length).toBeGreaterThanOrEqual(expected.length);
  });

  it("callTool('reflect_brief') → services 배열에 본 노드 한 행", async () => {
    const result = await client.callTool({ name: "reflect_brief", arguments: {} });
    const structured = result.structuredContent as { services: Array<{ name: string }> };
    expect(Array.isArray(structured.services)).toBe(true);
    expect(structured.services[0]?.name).toBe("soul-server-ts");
  });

  it("callTool('list_local_agents') → AgentRegistry 응답", async () => {
    const result = await client.callTool({
      name: "list_local_agents",
      arguments: {},
    });
    const structured = result.structuredContent as {
      agents: Array<{ id: string; name: string; max_turns: number | null }>;
    };
    expect(structured.agents).toHaveLength(1);
    expect(structured.agents[0]?.id).toBe("codex-default");
    expect(structured.agents[0]?.max_turns).toBe(50);
  });

  it("callTool('reflect_service', soul-server-ts, level=0) → identity + capabilities", async () => {
    const result = await client.callTool({
      name: "reflect_service",
      arguments: { service: "soul-server-ts", level: 0 },
    });
    const structured = result.structuredContent as {
      identity: { name: string };
      capabilities: Array<{ name: string; tools: string[] }>;
    };
    expect(structured.identity.name).toBe("soul-server-ts");
    const capNames = structured.capabilities.map((c) => c.name);
    expect(capNames).toEqual(
      expect.arrayContaining([
        "cogito",
        "session_query",
        "session_mgmt",
        "catalog",
        "multi_node",
      ]),
    );
  });

  it("callTool('reflect_service', 'unknown') → isError 응답", async () => {
    const result = await client.callTool({
      name: "reflect_service",
      arguments: { service: "unknown-service", level: 0 },
    });
    expect(result.isError).toBe(true);
  });

  it("callTool('list_nodes') — orch 미설정 → isError {error: 'multi-node not configured'}", async () => {
    const result = await client.callTool({
      name: "list_nodes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { error?: string };
    expect(structured.error).toBe("multi-node not configured");
  });
});
