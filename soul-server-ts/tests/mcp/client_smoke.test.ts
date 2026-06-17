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
  "list_child_folders",
  "browse_folder",
  "create_folder",
  "move_folder",
  "rename_folder",
  "delete_folder",
  "move_sessions_to_folder",
  "update_board_item_position",
  "create_markdown_document",
  "get_markdown_document",
  "update_markdown_document",
  "delete_markdown_document",
  "get_folder_system_prompt",
  "set_folder_system_prompt",
  "delete_session",
  // agent_config
  "get_agents_config",
  "list_mcp_registry",
  "list_mcp_profiles",
  "list_agents_config_snapshots",
  "plan_agent_profile_update",
  "plan_agent_mcp_profile_update",
  "update_agent_profile",
  "set_agent_mcp_profile",
  "set_agent_atom_contexts",
  "rollback_agents_config",
  // multi_node
  "list_nodes",
  "list_node_agents",
  "reflect_cluster_brief",
  "create_remote_agent_session",
  "plan_remote_agent_profile_update",
  "apply_remote_agent_profile_update",
  "list_remote_agents_config_snapshots",
  "rollback_remote_agents_config",
];

interface MockSqlCall {
  fragments: string[];
  values: unknown[];
}

function createMockSql() {
  const calls: MockSqlCall[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call = { fragments: Array.from(strings), values };
    calls.push(call);
    const text = call.fragments.join("|");
    if (text.includes("folder_get_all")) {
      return Promise.resolve([
        {
          id: "root",
          name: "Root",
          sort_order: 0,
          settings: {},
          parent_folder_id: null,
          created_at: null,
        },
        {
          id: "child",
          name: "Child",
          sort_order: 1,
          settings: {},
          parent_folder_id: "root",
          created_at: null,
        },
      ]);
    }
    if (text.includes("catalog_get_sessions")) {
      return Promise.resolve([
        { session_id: "sess-root", folder_id: "root", display_name: "Root Session" },
      ]);
    }
    if (text.includes("board_yjs_catalog_cache")) {
      return Promise.resolve([]);
    }
    if (text.includes("FROM board_items")) {
      return Promise.resolve([
        {
          id: "markdown:doc-1",
          folder_id: "root",
          item_type: "markdown",
          item_id: "doc-1",
          x: 0,
          y: 0,
          metadata: { title: "Spec", preview: "Short spec", version: 1 },
          created_at: null,
          updated_at: null,
        },
        {
          id: "asset:asset-1",
          folder_id: "root",
          item_type: "asset",
          item_id: "asset-1",
          x: 280,
          y: 0,
          metadata: {
            assetId: "asset-1",
            originalName: "image.png",
            mimeType: "image/png",
            byteSize: 1234,
          },
          created_at: null,
          updated_at: null,
        },
      ]);
    }
    if (text.includes("session_list_summary")) {
      return Promise.resolve([
        {
          session_id: "sess-root",
          display_name: "Root Session",
          status: "running",
          session_type: "claude",
          created_at: new Date("2026-06-17T00:00:00.000Z"),
          updated_at: new Date("2026-06-17T01:00:00.000Z"),
          event_count: "3",
          away_summary: null,
          caller_session_id: null,
          last_event_id: "30",
          last_read_event_id: "20",
          node_id: "test-node",
          total_count: "1",
        },
      ]);
    }
    return Promise.resolve([]);
  }) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    json: (value: unknown) => unknown;
    end: () => Promise<void>;
    begin: <T>(callback: (sql: SqlClient) => Promise<T>) => Promise<T>;
    __calls: MockSqlCall[];
  };
  fn.array = (a: unknown[]) => a;
  fn.json = (value: unknown) => value;
  fn.end = vi.fn().mockResolvedValue(undefined);
  fn.begin = vi.fn(async <T>(callback: (sql: SqlClient) => Promise<T>) =>
    callback(fn as unknown as SqlClient),
  );
  fn.__calls = calls;
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

let sqlCalls: MockSqlCall[] = [];

function makeRuntime(configPath: string, agentRegistry: AgentRegistry): McpRuntime {
  const sql = createMockSql() as SqlClient & { __calls: MockSqlCall[] };
  sqlCalls = sql.__calls;
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

async function callToolCapturingValidation(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    return err;
  }
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
      path.join(tempDir, "mcp-registry.yaml"),
      [
        "servers:",
        "  - id: docs",
        "    type: streamable_http",
        "    url: https://docs.example.com/mcp",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tempDir, "mcp-profiles.yaml"),
      [
        "profiles:",
        "  - id: research",
        "    name: Research",
        "    mcp_servers: [docs]",
        "    hosted_tools:",
        "      - type: web_search",
        "        search_context_size: low",
        "",
      ].join("\n"),
      "utf-8",
    );
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

  it("callTool('reflect_brief') → compact aggregate includes Level 0-3 sections", async () => {
    const result = await client.callTool({ name: "reflect_brief", arguments: {} });
    const structured = result.structuredContent as {
      schema_version: string;
      kind: string;
      status: string;
      services: Array<{
        name: string;
        data: {
          schema_version: string;
          service: string;
          level: number;
          kind: string;
          identity: { name: string };
          data: { identity: { name: string } };
          sections: {
            identity: { status: string; source: { level: number }; checked_at: string };
            configuration: { status: string; source: { level: number }; checked_at: string };
            source: { status: string; source: { level: number }; checked_at: string };
            runtime: {
              status: string;
              source: { level: number };
              checked_at: string;
              data: {
                dependencies: {
                  database: { status: string };
                  orchestrator: { status: string; checked_at: string };
                };
              };
            };
          };
          aggregate_sources: {
            orchestrator: { status: string; checked_at: string };
            manifest: { status: string; checked_at: string };
          };
        };
      }>;
    };
    expect(structured.schema_version).toBe("soulstream.reflect.v1");
    expect(structured.kind).toBe("compact_aggregate");
    expect(structured.status).toBe("ok");
    expect(Array.isArray(structured.services)).toBe(true);
    expect(structured.services[0]?.name).toBe("soul-server-ts");
    expect(structured.services[0]?.data.schema_version).toBe("soulstream.reflect.v1");
    expect(structured.services[0]?.data.service).toBe("soul-server-ts");
    expect(structured.services[0]?.data.kind).toBe("compact_aggregate");
    expect(structured.services[0]?.data.level).toBe(0);
    expect(structured.services[0]?.data.identity.name).toBe("soul-server-ts");
    expect(structured.services[0]?.data.data.identity.name).toBe("soul-server-ts");
    expect(structured.services[0]?.data.sections.identity.source.level).toBe(0);
    expect(structured.services[0]?.data.sections.configuration.source.level).toBe(1);
    expect(structured.services[0]?.data.sections.source.source.level).toBe(2);
    expect(structured.services[0]?.data.sections.runtime.source.level).toBe(3);
    expect(structured.services[0]?.data.sections.runtime.data.dependencies.database.status).toBe(
      "ok",
    );
    expect(
      structured.services[0]?.data.sections.runtime.data.dependencies.orchestrator.status,
    ).toBe("not_configured");
    expect(
      structured.services[0]?.data.sections.runtime.data.dependencies.orchestrator.checked_at,
    ).toEqual(expect.any(String));
    expect(structured.services[0]?.data.aggregate_sources.orchestrator.status).toBe(
      "not_configured",
    );
    expect(structured.services[0]?.data.aggregate_sources.manifest.status).toBe(
      "not_configured",
    );
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

  it("callTool('browse_folder') → 하위 폴더, 세션, 문서/이미지 보드 항목을 함께 반환", async () => {
    const result = await client.callTool({
      name: "browse_folder",
      arguments: { folder_id: "root", session_limit: 10 },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      folder_id: string;
      child_folders: Array<{ id: string; name: string }>;
      sessions: Array<{ sessionId: string; title: string; status: string | null }>;
      sessions_page: { total: number; nextCursor: number | null };
      board_items: Array<{ itemType: string; itemId: string; metadata: Record<string, unknown> }>;
      counts: { childFolders: number; sessions: number; boardItems: number; documents: number; assets: number };
    };
    expect(structured.folder_id).toBe("root");
    expect(structured.child_folders).toEqual([
      expect.objectContaining({ id: "child", name: "Child" }),
    ]);
    expect(structured.sessions).toEqual([
      expect.objectContaining({
        sessionId: "sess-root",
        title: "Root Session",
        status: "running",
      }),
    ]);
    expect(structured.sessions_page).toEqual({
      cursor: 0,
      limit: 10,
      total: 1,
      nextCursor: null,
    });
    expect(structured.board_items).toEqual([
      expect.objectContaining({
        itemType: "markdown",
        itemId: "doc-1",
        metadata: expect.objectContaining({ title: "Spec" }),
      }),
      expect.objectContaining({
        itemType: "asset",
        itemId: "asset-1",
        metadata: expect.objectContaining({ originalName: "image.png" }),
      }),
    ]);
    expect(structured.counts).toEqual({
      childFolders: 1,
      sessions: 1,
      boardItems: 2,
      documents: 1,
      assets: 1,
    });
  });

  it("callTool('move_folder') → 부모 이동, 루트 복귀, 순환 거부", async () => {
    sqlCalls.length = 0;

    const moved = await client.callTool({
      name: "move_folder",
      arguments: { folder_id: "child", parent_folder_id: "root" },
    });
    expect(moved.isError).not.toBe(true);
    expect(moved.structuredContent).toEqual({ ok: true });

    const rooted = await client.callTool({
      name: "move_folder",
      arguments: { folder_id: "child", parent_folder_id: null },
    });
    expect(rooted.isError).not.toBe(true);
    expect(rooted.structuredContent).toEqual({ ok: true });

    const updateCalls = sqlCalls.filter((call) =>
      call.fragments.join("|").includes("folder_update"),
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.values).toEqual([
      "child",
      ["parent_folder_id"],
      ["root"],
    ]);
    expect(updateCalls[1]?.values).toEqual([
      "child",
      ["parent_folder_id"],
      [null],
    ]);

    const cycle = await client.callTool({
      name: "move_folder",
      arguments: { folder_id: "root", parent_folder_id: "child" },
    });
    expect(cycle.isError).toBe(true);
    expect(cycle.structuredContent).toEqual({ error: "folder parent cycle" });
  });

  it("callTool('reflect_service', soul-server-ts, level=0) → identity + capabilities", async () => {
    const result = await client.callTool({
      name: "reflect_service",
      arguments: { service: "soul-server-ts", level: 0 },
    });
    const structured = result.structuredContent as {
      schema_version: string;
      service: string;
      level: number;
      data: {
        identity: { name: string };
        capabilities: Array<{ name: string; tools: string[] }>;
      };
    };
    expect(structured.schema_version).toBe("soulstream.reflect.v1");
    expect(structured.service).toBe("soul-server-ts");
    expect(structured.level).toBe(0);
    expect(structured.data.identity.name).toBe("soul-server-ts");
    const capNames = structured.data.capabilities.map((c) => c.name);
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

  it("callTool('reflect_service', level=2) → source-linked registry with line ranges", async () => {
    const result = await client.callTool({
      name: "reflect_service",
      arguments: { service: "soul-server-ts", level: 2, capability: "cogito" },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      schema_version: string;
      data: {
        source_root: { status: string; path?: string };
        sources: Array<{
          relative_path: string;
          absolute_path: string;
          capabilities: string[];
          entries: Array<{
            symbol: string;
            status: string;
            line_range: { start_line: number; end_line: number };
          }>;
        }>;
      };
    };
    expect(structured.schema_version).toBe("soulstream.reflect.v1");
    expect(structured.data.source_root.status).toBe("ok");
    const reflectSource = structured.data.sources.find(
      (source) => source.relative_path === "mcp/tools/reflect.ts",
    );
    expect(reflectSource?.absolute_path.endsWith("src/mcp/tools/reflect.ts")).toBe(true);
    expect(reflectSource?.capabilities).toContain("cogito");
    expect(reflectSource?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "registerReflectTools",
          status: "ok",
          line_range: expect.objectContaining({
            start_line: expect.any(Number),
            end_line: expect.any(Number),
          }),
        }),
      ]),
    );
    const entry = reflectSource?.entries.find((e) => e.symbol === "registerReflectTools");
    expect(entry?.line_range.start_line).toBeGreaterThan(0);
    expect(entry?.line_range.end_line).toBeGreaterThanOrEqual(entry?.line_range.start_line ?? 0);

    const sourceResolver = structured.data.sources.find(
      (source) => source.relative_path === "mcp/reflection/source_reflection.ts",
    );
    const resolverEntry = sourceResolver?.entries.find(
      (e) => e.symbol === "buildSourceReflection",
    );
    expect(resolverEntry?.line_range.start_line).toBeGreaterThan(150);
  });

  it("callTool('reflect_service', level=3) → process + runtime dependency statuses", async () => {
    const result = await client.callTool({
      name: "reflect_service",
      arguments: { service: "soul-server-ts", level: 3 },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      schema_version: string;
      data: {
        process: {
          pid: number;
          cwd: string;
          exec_path: string;
          argv: string[];
          uptime_seconds: number;
          memory: { rss: number; heap_used: number };
        };
        counts: { agent_count: number; active_task_count: number };
        dependencies: {
          database: { status: string };
          orchestrator: { status: string };
        };
      };
    };
    expect(structured.schema_version).toBe("soulstream.reflect.v1");
    expect(structured.data.process.pid).toBe(process.pid);
    expect(structured.data.process.cwd).toBe(process.cwd());
    expect(structured.data.process.exec_path).toBe(process.execPath);
    expect(structured.data.process.argv.length).toBeGreaterThan(0);
    expect(structured.data.process.memory.rss).toBeGreaterThan(0);
    expect(structured.data.process.memory.heap_used).toBeGreaterThan(0);
    expect(structured.data.counts.agent_count).toBe(1);
    expect(structured.data.counts.active_task_count).toBe(0);
    expect(structured.data.dependencies.database.status).toBe("ok");
    expect(structured.data.dependencies.orchestrator.status).toBe("not_configured");
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
      snapshot_path?: string;
      semantic_changes: Array<{ op: string; agent_id: string }>;
      agent: { atom_contexts?: Array<{ node_id: string; depth: number; titles_only: boolean }> };
    };
    expect(structured.snapshot_path).toBeTruthy();
    expect(structured.semantic_changes).toEqual([
      expect.objectContaining({
        op: "update_agent_atom_contexts",
        agent_id: "codex-default",
      }),
    ]);
    expect(structured.agent.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true },
    ]);
    expect(agentRegistry.get("codex-default")?.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true },
    ]);
    expect(fs.readFileSync(configPath, "utf-8")).toContain("atom_contexts:");

    const snapshots = await client.callTool({
      name: "list_agents_config_snapshots",
      arguments: {},
    });
    expect(snapshots.isError).not.toBe(true);
    const snapshotContent = snapshots.structuredContent as {
      snapshots: Array<{ snapshot_path: string; snapshot_id: string; size_bytes: number }>;
    };
    expect(snapshotContent.snapshots.some((s) => s.snapshot_path === structured.snapshot_path)).toBe(true);
    expect(snapshotContent.snapshots[0]?.snapshot_id).toBeTruthy();

    const rollback = await client.callTool({
      name: "rollback_agents_config",
      arguments: { snapshot_path: structured.snapshot_path },
    });
    expect(rollback.isError).not.toBe(true);
    expect(agentRegistry.get("codex-default")?.atom_contexts).toBeUndefined();
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("atom_contexts:");
  });

  it("callTool('list_mcp_registry'/'list_mcp_profiles') → canonical MCP presets", async () => {
    const registry = await client.callTool({
      name: "list_mcp_registry",
      arguments: {},
    });
    expect(registry.isError).not.toBe(true);
    const registryContent = registry.structuredContent as {
      servers: Array<{ id: string; type: string; url?: string }>;
    };
    expect(registryContent.servers).toEqual([
      expect.objectContaining({
        id: "docs",
        type: "streamable_http",
        url: "https://docs.example.com/mcp",
      }),
    ]);

    const profiles = await client.callTool({
      name: "list_mcp_profiles",
      arguments: {},
    });
    expect(profiles.isError).not.toBe(true);
    const profilesContent = profiles.structuredContent as {
      profiles: Array<{ id: string; mcp_servers: string[]; hosted_tools: Array<{ type: string }> }>;
    };
    expect(profilesContent.profiles).toEqual([
      expect.objectContaining({
        id: "research",
        mcp_servers: ["docs"],
        hosted_tools: [expect.objectContaining({ type: "web_search" })],
      }),
    ]);
  });

  it("callTool('set_agent_mcp_profile') → narrow agents.yaml update + registry reload", async () => {
    const result = await client.callTool({
      name: "set_agent_mcp_profile",
      arguments: {
        agent_id: "codex-default",
        mcp_profile: "research",
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      snapshot_path?: string;
      semantic_changes: Array<{ op: string; agent_id: string; after: string }>;
      agent: { mcp_profile?: string };
    };
    expect(structured.snapshot_path).toBeTruthy();
    expect(structured.semantic_changes).toEqual([
      expect.objectContaining({
        op: "update_agent_mcp_profile",
        agent_id: "codex-default",
        after: "research",
      }),
    ]);
    expect(structured.agent.mcp_profile).toBe("research");
    expect(agentRegistry.get("codex-default")?.mcp_profile).toBe("research");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("mcp_profile: research");

    const rollback = await client.callTool({
      name: "rollback_agents_config",
      arguments: { snapshot_path: structured.snapshot_path },
    });
    expect(rollback.isError).not.toBe(true);
    expect(agentRegistry.get("codex-default")?.mcp_profile).toBeUndefined();
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("mcp_profile:");
  });

  it("callTool('set_agent_mcp_profile') without mcp_profile → validation error, no file write", async () => {
    const before = fs.readFileSync(configPath, "utf-8");

    const result = await callToolCapturingValidation(
      client,
      "set_agent_mcp_profile",
      { agent_id: "codex-default" },
    );

    expect(JSON.stringify(result)).toContain("mcp_profile");
    if (result && typeof result === "object" && "isError" in result) {
      expect((result as { isError?: boolean }).isError).toBe(true);
    }
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(agentRegistry.get("codex-default")?.mcp_profile).toBeUndefined();
  });

  it("callTool('update_markdown_document') without expected_version → validation error", async () => {
    const result = await callToolCapturingValidation(
      client,
      "update_markdown_document",
      { document_id: "doc-1", body: "Body" },
    );

    expect(JSON.stringify(result)).toContain("expected_version");
    if (result && typeof result === "object" && "isError" in result) {
      expect((result as { isError?: boolean }).isError).toBe(true);
    }
  });

  it("callTool('plan_agent_mcp_profile_update') → read-only semantic plan", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await client.callTool({
      name: "plan_agent_mcp_profile_update",
      arguments: {
        agent_id: "codex-default",
        mcp_profile: "research",
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      changed: boolean;
      semantic_changes: Array<{ op: string; agent_id: string; after: string }>;
      text_diff_included: boolean;
      diff: string;
    };
    expect(structured.changed).toBe(true);
    expect(structured.semantic_changes).toEqual([
      expect.objectContaining({
        op: "update_agent_mcp_profile",
        agent_id: "codex-default",
        after: "research",
      }),
    ]);
    expect(structured.text_diff_included).toBe(false);
    expect(structured.diff).toBe("");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(agentRegistry.get("codex-default")?.mcp_profile).toBeUndefined();
  });

  it("callTool('plan_agent_profile_update') → semantic plan by default, no file write", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const result = await client.callTool({
      name: "plan_agent_profile_update",
      arguments: {
        profile: {
          id: "codex-default",
          name: "Codex Planned",
          backend: "codex",
          workspace_dir: "/tmp/codex-ws",
        },
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      changed: boolean;
      semantic_changes: Array<{ op: string; agent_id: string }>;
      text_diff_included: boolean;
      diff: string;
      comment_preservation: string;
    };
    expect(structured.changed).toBe(true);
    expect(structured.semantic_changes).toEqual([
      expect.objectContaining({
        op: "replace_agent",
        agent_id: "codex-default",
      }),
    ]);
    expect(structured.text_diff_included).toBe(false);
    expect(structured.diff).toBe("");
    expect(structured.comment_preservation).toBe("not_preserved");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(agentRegistry.get("codex-default")?.name).toBe("Codex");
  });

  it("callTool('plan_agent_profile_update') → include_text_diff returns legacy diff", async () => {
    const result = await client.callTool({
      name: "plan_agent_profile_update",
      arguments: {
        include_text_diff: true,
        profile: {
          id: "codex-default",
          name: "Codex Planned",
          backend: "codex",
          workspace_dir: "/tmp/codex-ws",
        },
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      text_diff_included: boolean;
      diff: string;
    };
    expect(structured.text_diff_included).toBe(true);
    expect(structured.diff).toContain("Codex Planned");
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
