/**
 * SDK Client smoke 테스트 — `@modelcontextprotocol/sdk/client/streamableHttp.js`로 실제 접속.
 *
 * 검증:
 *   - listTools() → MCP 도구 이름 노출
 *   - callTool("reflect_brief") → services 배열
 *   - callTool("list_local_agents") → AgentRegistry 응답
 */
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { AgentRegistry } from "../../src/agent_registry.js";
import { CatalogService } from "../../src/catalog/catalog_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import type { FolderHostClient } from "../../src/folder/folder_host_client.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildInternalMcpServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { configureTestBoardProjectionReadHost } from "../helpers/configure_test_board_projection_host.js";

import { makeTempDirSync } from "../helpers/temp_dir.js";

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
    if (text.includes("FROM folders") && text.includes("WHERE id")) {
      const id = values[0];
      const folders = [
        {
          id: "root",
          name: "Root",
          sort_order: 0,
          settings: {},
          parent_folder_id: null,
          project_page_id: "page-root",
          version: 1,
          created_at: null,
        },
        {
          id: "child",
          name: "Child",
          sort_order: 1,
          settings: {},
          parent_folder_id: "root",
          project_page_id: "page-child",
          version: 1,
          created_at: null,
        },
      ];
      return Promise.resolve(folders.filter((folder) => folder.id === id));
    }
    if (text.includes("folder_get_all")) {
      return Promise.resolve([
        {
          id: "root",
          name: "Root",
          sort_order: 0,
          settings: {},
          parent_folder_id: null,
          project_page_id: "page-root",
          archived: false,
          created_at: null,
        },
        {
          id: "child",
          name: "Child",
          sort_order: 1,
          settings: {},
          parent_folder_id: "root",
          project_page_id: "page-child",
          archived: false,
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
    if (text.includes("scoped AS") && text.includes("FROM board_items bi")) {
      const itemTypes = values.find((value): value is string[] =>
        Array.isArray(value) && value.every((item) => typeof item === "string")
          && value.some((item) => ["session", "markdown", "asset"].includes(item))
      );
      const rows = itemTypes
        ? containerItemRows().filter((row) => itemTypes.includes(row.bi_item_type))
        : containerItemRows();
      return Promise.resolve(withContainerCounts(rows));
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

function containerItemRows() {
  const counts = {
    total_count: 3,
    session_count: 1,
    markdown_count: 1,
    subfolder_count: 0,
    asset_count: 1,
    frame_count: 0,
    task_count: 0,
    custom_view_count: 0,
  };
  const base = {
    bi_folder_id: "root",
    bi_container_kind: "folder",
    bi_container_id: "root",
    bi_membership_kind: "primary",
    bi_source_task_item_id: null,
    bi_x: 0,
    bi_y: 0,
    bi_created_at: null,
    bi_updated_at: new Date("2026-06-17T01:00:00.000Z"),
    item_archived: false,
    session_display_name: null,
    session_status: null,
    session_type: null,
    session_created_at: null,
    session_updated_at: null,
    session_event_count: 0,
    session_away_summary: null,
    session_caller_session_id: null,
    session_predecessor_session_id: null,
    session_node_id: null,
    session_agent_id: null,
    session_last_event_id: null,
    session_last_read_event_id: null,
    session_last_user_preview: null,
    markdown_id: null,
    markdown_title: null,
    markdown_body: null,
    markdown_updated_at: null,
    task_id: null,
    task_title: null,
    task_updated_at: null,
    custom_view_id: null,
    custom_view_title: null,
    custom_view_updated_at: null,
    asset_id: null,
    asset_title: null,
    asset_updated_at: null,
    subfolder_id: null,
    subfolder_title: null,
  };
  return [
    {
      ...base,
      ...counts,
      bi_id: "session:sess-root",
      bi_item_type: "session",
      bi_item_id: "sess-root",
      bi_metadata: {},
      session_display_name: "Root Session",
      session_status: "running",
      session_type: "claude",
      session_created_at: new Date("2026-06-17T00:00:00.000Z"),
      session_updated_at: new Date("2026-06-17T01:00:00.000Z"),
      session_event_count: 3,
      session_node_id: "test-node",
      session_agent_id: "codex-default",
      session_last_event_id: 30,
      session_last_read_event_id: 20,
      session_last_user_preview: "Root prompt",
    },
    {
      ...base,
      ...counts,
      bi_id: "markdown:doc-1",
      bi_item_type: "markdown",
      bi_item_id: "doc-1",
      bi_metadata: { title: "Spec", preview: "Short spec", version: 1 },
      markdown_id: "doc-1",
      markdown_title: "Spec",
      markdown_body: "Short spec body",
      markdown_updated_at: new Date("2026-06-17T00:59:00.000Z"),
    },
    {
      ...base,
      ...counts,
      bi_id: "asset:asset-1",
      bi_item_type: "asset",
      bi_item_id: "asset-1",
      bi_x: 280,
      bi_metadata: { originalName: "image.png" },
      asset_id: "asset-1",
      asset_title: "image.png",
      asset_updated_at: new Date("2026-06-17T00:58:00.000Z"),
    },
  ];
}

function withContainerCounts(rows: ReturnType<typeof containerItemRows>) {
  const count = (type: string) => rows.filter((row) => row.bi_item_type === type).length;
  return rows.map((row) => ({
    ...row,
    total_count: rows.length,
    session_count: count("session"),
    markdown_count: count("markdown"),
    subfolder_count: count("subfolder"),
    asset_count: count("asset"),
    frame_count: count("frame"),
    task_count: count("task"),
    custom_view_count: count("custom_view"),
    scanned_items: rows.length,
    search_truncated: false,
  }));
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
let smokeSql: SqlClient;
let smokeProjection: ReturnType<typeof configureTestBoardProjectionReadHost>;
const worktreeList = vi.fn(async (input: unknown) => [{ input }]);
const worktreeCreate = vi.fn(async (input: unknown) => ({ input, created: true }));
const renameFolder = vi.fn(async () => ({ folder: {}, operation: {}, idempotent: false }));

function makeRuntime(configPath: string, agentRegistry: AgentRegistry): McpRuntime {
  const sql = createMockSql() as SqlClient & { __calls: MockSqlCall[] };
  sqlCalls = sql.__calls;
  const db = new SessionDB();
  smokeSql = sql;
  smokeProjection = configureTestBoardProjectionReadHost(db, sql);
  db.configureFolderHost(
    new FolderControlPlaneService(sql as never) as unknown as FolderHostClient,
  );
  const broadcaster = {
    emitCatalogUpdated: vi.fn().mockResolvedValue(undefined),
    emitSessionDeleted: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const catalogService = new CatalogService(db, broadcaster, undefined);
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
    onResume: () => undefined,
    agentRegistry,
    catalogService,
    logger: createSilentLogger(),
    worktreeService: {
      list: worktreeList,
      create: worktreeCreate,
      remove: vi.fn(),
      deleteBranch: vi.fn(),
    } as unknown as NonNullable<McpRuntime["worktreeService"]>,
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
  let server: Awaited<ReturnType<typeof buildInternalMcpServer>>;
  let client: Client;
  let url: URL;
  let tempDir: string;
  let configPath: string;
  let agentRegistry: AgentRegistry;
  let orch: ReturnType<typeof Fastify>;
  let smokeRuntime: McpRuntime;
  let smokeOrchConfig: McpRuntime["orch"];

  beforeAll(async () => {
    tempDir = makeTempDirSync("soul-mcp-smoke-");
    configPath = path.join(tempDir, "agents.yaml");
    fs.writeFileSync(
      path.join(tempDir, "mcp-registry.yaml"),
      [
        "servers:",
        "  - id: docs",
        "    type: streamable_http",
        "    url: https://docs.example.com/mcp?exaApiKey=fake-docs-key&tools=search,fetch",
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
    const runtime = makeRuntime(configPath, agentRegistry);
    smokeRuntime = runtime;
    orch = Fastify();
    const cards = new CardControlPlaneService(createBoardYjsSqlAdapter(smokeSql as never), { appendEventTx: async () => 1 }, { emitFolderUpdated: async () => {}, emitCardUpdated: async () => {} });
    registerMcpHostRoutes(orch, { authBearerToken: "smoke-token", folders: {
      authBearerToken: "smoke-token", serviceProvider: async () => new FolderControlPlaneService(smokeSql as never),
      cardServiceProvider: async () => cards, identity: { create: vi.fn(), mutateFromFolder: renameFolder },
    }, cards: undefined as never, board: { host: { authBearerToken: "smoke-token", service: {} as never, projectionHost: smokeProjection as never },
      getSession: async () => null, listAgentProfiles: async () => ({ "codex-default": { name: "Codex" } }),
      broadcaster: { append: () => {} } as never,
    } });
    smokeOrchConfig = { baseUrl: await orch.listen({ host: "127.0.0.1", port: 0 }), headers: { authorization: "Bearer smoke-token" } };
    server = await buildInternalMcpServer({
      logger: createSilentLogger(),
      runtime,
      path: "/mcp/internal",
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
      statelessTransport: true,
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    url = new URL(`${baseUrl}/mcp/internal`);

    client = new Client({ name: "smoke-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
  });

  beforeEach(({ task }) => {
    // Only migrated tools need the orchestrator; keep the other smoke tests' unconfigured runtime.
    smokeRuntime.orch = ["browse_folder", "search_folder_items", "move_folder"].some(name => task.name.includes(`'${name}'`))
      ? smokeOrchConfig : undefined;
  });

  afterAll(async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    if (server.closeMcp) await server.closeMcp();
    await server.close();
    await orch.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("listTools — Python 호환 이름 + agent_config 도구 모두 노출", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toContain("reflect_service");
    expect(names).toContain("get_agents_config");
    expect(
      result.tools.find((tool) => tool.name === "list_node_model_presets")
        ?.inputSchema,
    ).toMatchObject({
      type: "object",
      required: ["node_id"],
      properties: {
        node_id: {
          type: "string",
          minLength: 1,
        },
      },
    });
    expect(result.tools.find((tool) => tool.name === "list_worktrees")?.annotations)
      .not.toMatchObject({ destructiveHint: true });
    for (const name of ["create_worktree", "remove_worktree", "delete_worktree_branch"]) {
      expect(result.tools.find((tool) => tool.name === name)?.annotations)
        .toMatchObject({ destructiveHint: true });
    }
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
      "not_configured",
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

  it("calls local worktree tools with the trusted caller attribution", async () => {
    const listed = await client.callTool({
      name: "list_worktrees",
      arguments: { repo_id: "soulstream", caller_session_id: "session-owner" },
    });
    expect(listed.isError).not.toBe(true);
    expect(worktreeList).toHaveBeenCalledWith({
      actorSessionId: "session-owner",
      repoId: "soulstream",
    });

    const created = await client.callTool({
      name: "create_worktree",
      arguments: {
        repo_id: "soulstream",
        branch: "feature/mcp",
        mode: "new",
        caller_session_id: "session-owner",
      },
    });
    expect(created.isError).not.toBe(true);
    expect(worktreeCreate).toHaveBeenCalledWith(expect.objectContaining({
      actorSessionId: "session-owner",
      repoId: "soulstream",
      branch: "feature/mcp",
      mode: "new",
      setup: "none",
      requireSetup: false,
    }));
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

  it("callTool('search_folder_items') → 세션 표시명·문서만 최대 50개로 검색", async () => {
    const result = await client.callTool({
      name: "search_folder_items",
      arguments: {
        folder_id: "root",
        query: "Spec",
        limit: 999,
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      items: Array<{ type: string }>;
      page: { limit: number };
      truncated: boolean;
      scanned_items: number;
      scan_limit: number;
    };
    expect(structured.items.map((item) => item.type)).toEqual(["session", "markdown"]);
    expect(structured.page.limit).toBe(50);
    expect(structured.truncated).toBe(false);
    expect(structured.scanned_items).toBe(2);
    expect(structured.scan_limit).toBe(2_000);
  });

  it("callTool('move_folder') → 새 폴더 host 계약으로 부모 이동과 루트 복귀", async () => {
    renameFolder.mockClear();

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

    expect(renameFolder).toHaveBeenCalledTimes(2);
    expect(renameFolder).toHaveBeenNthCalledWith(1, expect.objectContaining({ folderId: "child", update: { parentFolderId: "root" }, actor: { actorKind: "system", actorSessionId: null, actorUserId: null } }));
    expect(renameFolder).toHaveBeenNthCalledWith(2, expect.objectContaining({ folderId: "child", update: { parentFolderId: null } }));
  });

  it("level=0 capability inventory matches the registered MCP tools", async () => {
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
    expect(structured.data.capabilities).toEqual([
      {
        name: "mcp_tools",
        description: expect.any(String),
        tools: (await client.listTools()).tools.map((tool) => tool.name).sort(),
      },
    ]);
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
    expect(structured.data.dependencies.database.status).toBe("not_configured");
    expect(structured.data.dependencies.orchestrator.status).toBe("not_configured");
  });

  it("callTool('set_agent_atom_contexts') → agents.yaml 갱신 + runtime registry reload", async () => {
    const nodeId = "11111111-2222-3333-4444-555555555555";
    const result = await client.callTool({
      name: "set_agent_atom_contexts",
      arguments: {
        agent_id: "codex-default",
        atom_contexts: [{
          node_id: nodeId,
          depth: 2,
          titles_only: true,
          include_ids: false,
        }],
      },
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      snapshot_path?: string;
      semantic_changes: Array<{ op: string; agent_id: string }>;
      agent: {
        atom_contexts?: Array<{
          node_id: string;
          depth: number;
          titles_only: boolean;
          include_ids?: boolean;
        }>;
      };
    };
    expect(structured.snapshot_path).toBeTruthy();
    expect(structured.semantic_changes).toEqual([
      expect.objectContaining({
        op: "update_agent_atom_contexts",
        agent_id: "codex-default",
      }),
    ]);
    expect(structured.agent.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true, include_ids: false },
    ]);
    expect(agentRegistry.get("codex-default")?.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true, include_ids: false },
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
        url: "https://docs.example.com/mcp?exaApiKey=<redacted>&tools=search,fetch",
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
