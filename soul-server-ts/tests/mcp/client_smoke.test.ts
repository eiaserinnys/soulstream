/**
 * SDK Client smoke 테스트 — `@modelcontextprotocol/sdk/client/streamableHttp.js`로 실제 접속.
 *
 * 검증:
 *   - listTools() → MCP 도구 이름 노출
 *   - callTool("reflect_brief") → services 배열
 *   - callTool("list_local_agents") → AgentRegistry 응답
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // agent_config
  "get_agents_config",
  "update_agent_profile",
  "set_agent_atom_contexts",
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

function makeRuntime(configPath: string, agentRegistry: AgentRegistry): McpRuntime {
  const sql = createMockSql();
  const db = new SessionDB(sql);
  const broadcaster = {
    emitCatalogUpdated: vi.fn().mockResolvedValue(undefined),
    emitSessionDeleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const catalogService = new CatalogService(db, broadcaster);
  const taskManager = {
    listTasks: () => [],
    getTask: () => undefined,
  } as unknown as TaskManager;
  const taskExecutor = {} as unknown as TaskExecutor;
  return {
    nodeId: "test-node",
    agentsConfigPath: configPath,
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
  let tempDir: string;
  let configPath: string;
  let agentRegistry: AgentRegistry;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-mcp-smoke-"));
    configPath = path.join(tempDir, "agents.yaml");
    fs.writeFileSync(
      configPath,
      [
        "agents:",
        "  - id: codex-default",
        "    name: Codex",
        "    backend: codex",
        "    workspace_dir: /tmp/codex-ws",
        "    max_turns: 50",
        "",
      ].join("\n"),
      "utf-8",
    );
    agentRegistry = new AgentRegistry([
      {
        id: "codex-default",
        name: "Codex",
        backend: "codex",
        workspace_dir: "/tmp/codex-ws",
        max_turns: 50,
      },
    ]);
    server = await buildServer({
      host: "127.0.0.1",
      port: 0,
      nodeId: "test-node",
      logger: createSilentLogger(),
      mcp: {
        runtime: makeRuntime(configPath, agentRegistry),
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
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("listTools — Python 호환 이름 + agent_config 도구 모두 노출", async () => {
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
        "agent_config",
        "multi_node",
      ]),
    );
  });

  it("callTool('set_agent_atom_contexts') → agents.yaml 갱신 + runtime registry reload", async () => {
    const nodeId = "11111111-2222-3333-4444-555555555555";
    const result = await client.callTool({
      name: "set_agent_atom_contexts",
      arguments: {
        agent_id: "codex-default",
        atom_contexts: [{ node_id: nodeId, depth: 2, titles_only: true }],
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      agent: { atom_contexts?: Array<{ node_id: string; depth: number; titles_only: boolean }> };
    };
    expect(structured.agent.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true },
    ]);
    expect(agentRegistry.get("codex-default")?.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true },
    ]);
    expect(fs.readFileSync(configPath, "utf-8")).toContain("atom_contexts:");
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
