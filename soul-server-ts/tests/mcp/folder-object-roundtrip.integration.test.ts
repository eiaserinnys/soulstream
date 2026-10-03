import { unusedClusterDependencies } from "../../../orch-server-ts/tests/mcp-cluster-unused-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { FolderProjectIdentityService } from "../../../orch-server-ts/src/folders/folder_project_identity_service.js";
import { SqlFolderProjectIdentityRepository } from "../../../orch-server-ts/src/folders/folder_project_identity_repository.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerFolderObjectTools } from "../../src/mcp/tools/folder_object_tools.js";

const folderId = "00000000-0000-4000-8000-000000000001";
const mutation = { folder_id: folderId, expected_version: 1, idempotency_key: "tool-change" };
const cases = [
  ["create_folder", { name: "새 폴더", idempotency_key: "tool-create" }],
  ["list_child_folders", {}],
  ["get_folder", { folder_id: folderId }],
  ["rename_folder", { ...mutation, name: "새 이름" }],
  ["archive_folder", mutation],
  ["unarchive_folder", mutation],
  ["set_folder_status", { ...mutation, status: "completed" }],
  ["list_folder_operations", { folder_id: folderId }],
  ["create_folder", { name: "문맥", idempotency_key: "tool-context", initial_context: {
    guidance: "지시", atom_references: [{ instance: "atom", node_id: "reference", node_title: "제목", depth: 1, titles_only: false }],
    session_defaults: { agent_id: "roselin", node_id: "test-node", model_preset: "sol" },
  } }],
  ["rename_folder", { ...mutation, name: "충돌", expected_version: 999 }],
  ["get_folder", { folder_id: "missing" }],
  ["rename_folder", { ...mutation, folder_id: "missing", name: "없음" }],
  ["rename_folder", { ...mutation, folder_id: "claude", name: "시스템" }],
] as const;

// Actual SDK, host routes, services and disposable PG, as in page-roundtrip.integration.test.ts.
describe("folder object orchestrator MCP roundtrip", () => {
  let h: PagePostgresHarness;
  let identity: FolderProjectIdentityService;
  let app: ReturnType<typeof Fastify>;
  let runtime: McpRuntime;
  let sequence = 0;
  let operationSequence = 0;
  const context = { callerSessionId: "header-session" };

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    const cards = new CardControlPlaneService(sql, { appendEventTx: async () => 1 }, {
      emitFolderUpdated: async () => {}, emitCardUpdated: async () => {},
    });
    identity = new FolderProjectIdentityService({
      repository: new SqlFolderProjectIdentityRepository(createLiveDbSqlResolver({ sql: h.liveSql })),
      createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      createOperationId: () => `10000000-0000-4000-8000-${String(++operationSequence).padStart(12, "0")}`,
      withBoardApplication: async (_input, persist) => persist([]), hydratePage: async () => {},
    });
    const options = { serviceProvider: async () => new FolderControlPlaneService(sql),
      cardServiceProvider: async () => cards, identity, authBearerToken: "service-token" };
    app = Fastify();
    registerMcpHostRoutes(app, { ...unusedClusterDependencies, board: undefined as never, authBearerToken: options.authBearerToken, folders: options, cards: {
      cardServiceProvider: options.cardServiceProvider, provider: { listFolders: () => [], listSessionAssignments: () => ({}) },
      resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }),
    } });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer service-token" } };
    const logger = { warn: vi.fn() } as never;
    runtime = { nodeId: "test-node", orch, logger } as McpRuntime;
  }, 60_000);

  afterAll(async () => { await app?.close(); await h?.cleanup(); });

  async function seed() {
    // Only the isolated schema owned by the disposable harness is cleared.
    const tables = await h.sql<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`;
    await h.sql.unsafe(`TRUNCATE ${tables.map(t => '"' + t.tablename.replaceAll('"', '""') + '"').join(",")} RESTART IDENTITY CASCADE`);
    await h.sql`INSERT INTO sessions(session_id) VALUES ('header-session'), ('argument-session')`;
    sequence = 0; operationSequence = 0;
    await identity.create({ name: "기존 폴더", actor: { actorKind: "agent", actorSessionId: "header-session" }, idempotencyKey: "seed" });
  }

  async function call(name: string, input: object, requestContext: McpRequestContext) {
    const server = new McpServer({ name: "parity", version: "1" });
    registerFolderObjectTools(server, runtime);
    const client = new Client({ name: "parity-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await withMcpRequestContext(requestContext, () => client.callTool({ name, arguments: input as Record<string, unknown> }));
    } finally { await client.close(); await server.close(); }
  }

  async function roundtrip(name: string, input: object, requestContext = context) {
    await seed(); const next = await call(name, input, requestContext);
    expect(serializeResult(name, next)).toMatchSnapshot();
    return next;
  }

  it.each(cases)("preserves %s for %j", async (name, input) => {
    const result = await roundtrip(name, input);
    if ("folder_id" in input && input.folder_id === "missing" && name === "get_folder") {
      expect(result.structuredContent).toEqual({ result: null });
    } else if ("expected_version" in input && (input.expected_version === 999 || input.folder_id === "missing" || input.folder_id === "claude")) {
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(`folder host ${name} failed:`) });
    } else { expect(result.isError).not.toBe(true); }
  });
  it("preserves the missing internal actor error", async () => {
    const result = await roundtrip("rename_folder", { ...mutation, name: "이름" }, {});
    expect(result.content[0]).toMatchObject({ text: "caller session id is required for folder mutation tools. Send x-soulstream-agent-session-id." });
  });
  it("prefers the trimmed argument session over the header", async () => {
    const result = await roundtrip("rename_folder", { ...mutation, name: "이름", caller_session_id: " argument-session " });
    expect(result.structuredContent).toMatchObject({ operation: { actorKind: "agent", actorSessionId: "argument-session" } });
  });
});

// Only paths observed in the failed parity output are masked.
const randomIdPaths: Record<string, readonly string[]> = {
  // CardMutationCore.setFolderStatus: card_mutation_core.ts:160 creates opId with randomUUID().
  set_folder_status: ["operation.id"],
};

function mask(tool: string, value: unknown, path: string[] = []): unknown {
  if (randomIdPaths[tool]?.includes(path.join("."))) return "<random-id>";
  if (Array.isArray(value)) return value.map((child, index) => mask(tool, child, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /_at$|At$/.test(key) && child !== null ? "<time>" : mask(tool, child, [...path, key]),
  ]));
}

function serializeResult(tool: string, result: unknown): string {
  const value = result as { content: { type: string; text?: string }[]; structuredContent?: unknown };
  return JSON.stringify({
    ...value,
    content: value.content.map(item => {
      if (item.type !== "text") return item;
      let parsed: unknown;
      try { parsed = JSON.parse(item.text!); } catch { return item; }
      expect(item.text).toBe(JSON.stringify(parsed, null, 2));
      return { ...item, text: JSON.stringify(mask(tool, parsed), null, 2) };
    }),
    ...(value.structuredContent === undefined ? {} : { structuredContent: mask(tool, value.structuredContent) }),
  }, null, 2);
}

describe("folder result masking", () => {
  it("masks only the listed random ID and timestamp fields", () => {
    expect(mask("set_folder_status", { operation: { id: "random", createdAt: "now" }, folder: { id: folderId } }))
      .toEqual({ operation: { id: "<random-id>", createdAt: "<time>" }, folder: { id: folderId } });
    expect(mask("get_folder", { id: folderId, completed_at: null })).toEqual({ id: folderId, completed_at: null });
  });
});
