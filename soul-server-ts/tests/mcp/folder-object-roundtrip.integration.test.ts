import { unusedClusterDependencies } from "../../../orch-server-ts/tests/mcp-cluster-unused-fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import type { FolderControlPlaneHostRouteOptions } from "../../../orch-server-ts/src/folders/folder_control_plane_host_route.js";
import { FolderControlPlaneService } from "../../../orch-server-ts/src/folders/folder_control_plane_service.js";
import { FolderProjectIdentityService } from "../../../orch-server-ts/src/folders/folder_project_identity_service.js";
import { SqlFolderProjectIdentityRepository } from "../../../orch-server-ts/src/folders/folder_project_identity_repository.js";
import { buildExternalMcpServer } from "../../../orch-server-ts/src/mcp/external_ingress_server.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import type { McpHostOptions } from "../../../orch-server-ts/src/mcp/types.js";
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
  let folderHostOptions: FolderControlPlaneHostRouteOptions;
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
    folderHostOptions = options;
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
    await h.sql`ALTER SEQUENCE cards_number_seq RESTART WITH 1`;
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

  async function callExternal(name: string, input: object) {
    const server = buildExternalMcpServer({ folders: folderHostOptions } as unknown as McpHostOptions, {
      principal: "external", callerSessionId: null, nodeId: "test-node",
    });
    const client = new Client({ name: "external-parity-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await client.callTool({ name, arguments: input as Record<string, unknown> });
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
  it("returns a bounded outline with archived filtering, stable pages, and no activity bodies", async () => {
    await seed();
    await h.sql`INSERT INTO folders(id,name) VALUES ('outline-empty','빈 폴더')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,brief,status,archived,version,created_at,updated_at)
      SELECT 'outline-' || lpad(i::text,3,'0'), ${folderId}, lpad(i::text,3,'0'), '카드 ' || i,
        CASE WHEN i=4 THEN '' ELSE '짧은 요청' END, '짧은 경과', CASE WHEN i=5 THEN 'done' ELSE 'todo' END,
        i > 25, 4, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'
      FROM generate_series(1,100) AS rows(i)`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at)
      VALUES ('outline-comment','outline-001','user','spoken','짧은 지시','2026-09-03T00:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,created_at)
      VALUES ('outline-report','outline-002','보고','html','<p>짧은 보고</p>','2026-09-03T00:00:00Z')`;

    async function read(input: Record<string, unknown> = {}) {
      const result = await call("get_folder", { folder_id: folderId, view: "outline", ...input }, context);
      const text = (result.content[0] as { type: string; text: string }).text;
      const value = JSON.parse(text) as {
        cards: Record<string, unknown>[]; view: string; includeArchived: boolean;
        totalCards: number; returnedCount: number; nextCursor: string | null;
      };
      expect(result.structuredContent).toEqual(value);
      return { result, text, value };
    }

    const first = await read();
    const firstIds = Array.from({ length: 20 }, (_, index) => `outline-${String(index + 1).padStart(3, "0")}`);
    expect(first.value).toMatchObject({ view: "outline", includeArchived: false, totalCards: 25, returnedCount: 20, nextCursor: "20" });
    expect(first.value.cards.map(card => card.id)).toEqual(firstIds);
    expect(first.value.cards[4]).toMatchObject({ status: "done", archived: false });
    expect(Object.keys(first.value.cards[0]!).sort()).toEqual([
      "id", "number", "title", "status", "archived", "version", "assigneeKind", "assigneeAgentId",
      "assigneeSessionId", "assigneeUserId", "nodeId", "modelPreset", "blockedKind", "updatedAt", "latestActivity",
    ].sort());
    expect(first.value.cards[0]!.latestActivity).toEqual({ kind: "instruction", createdAt: "2026-09-03T00:00:00.000Z" });
    expect(first.value.cards[1]!.latestActivity).toEqual({ kind: "report", createdAt: "2026-09-03T00:00:00.000Z" });
    expect(first.value.cards[2]!.latestActivity).toEqual({ kind: "instruction", createdAt: "2026-09-01T00:00:00.000Z" });
    expect(first.value.cards[3]!.latestActivity).toBeNull();
    expect(first.text.length).toBeLessThan(20_000);

    const external = await callExternal("get_folder", { folder_id: folderId, view: "outline" });
    expect(JSON.parse((external.content[0] as { text: string }).text)).toEqual(first.value);
    expect(external.structuredContent).toEqual(first.value);

    const second = await read({ cursor: "20" });
    expect(second.value).toMatchObject({ includeArchived: false, totalCards: 25, returnedCount: 5, nextCursor: null });
    expect([...firstIds, ...second.value.cards.map(card => card.id)]).toEqual(
      Array.from({ length: 25 }, (_, index) => `outline-${String(index + 1).padStart(3, "0")}`),
    );

    const archivedPageOne = await read({ include_archived: true, limit: 50 });
    const archivedPageTwo = await read({ include_archived: true, limit: 50, cursor: "50" });
    const allIds = [...archivedPageOne.value.cards, ...archivedPageTwo.value.cards].map(card => card.id);
    expect(archivedPageOne.value).toMatchObject({ includeArchived: true, totalCards: 100, returnedCount: 50, nextCursor: "50" });
    expect(archivedPageTwo.value).toMatchObject({ includeArchived: true, totalCards: 100, returnedCount: 50, nextCursor: null });
    expect(allIds).toEqual(Array.from({ length: 100 }, (_, index) => `outline-${String(index + 1).padStart(3, "0")}`));
    expect(new Set(allIds).size).toBe(100);

    await h.sql`UPDATE cards SET request=repeat('요청',60000), brief=repeat('경과',30000) WHERE id='outline-003'`;
    await h.sql`UPDATE card_comments SET body=repeat('# 지시\n',4000) WHERE id='outline-comment'`;
    await h.sql`UPDATE card_reports SET body='<article>' || repeat('<p>보고</p>',4000) || '</article>' WHERE id='outline-report'`;
    const longBodies = await read();
    expect(longBodies.text.length).toBe(first.text.length);
    expect(longBodies.value.cards[0]!.latestActivity).not.toHaveProperty("body");
    expect(longBodies.value.cards[1]!.latestActivity).not.toHaveProperty("format");
    expect(longBodies.value.cards[2]).not.toHaveProperty("request");
    expect(longBodies.value.cards[2]).not.toHaveProperty("brief");

    const archivedDirect = await call("get_folder", {
      folder_id: folderId, view: "outline", card_id: "outline-050",
      include_archived: false, limit: 1, cursor: "50",
    }, context);
    const archivedValue = JSON.parse((archivedDirect.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(archivedValue).toMatchObject({ view: "outline", includeArchived: true, totalCards: 1, returnedCount: 1, nextCursor: null });
    expect(archivedValue.cards).toMatchObject([{ id: "outline-050", archived: true }]);

    const fullDirect = await call("get_folder", { folder_id: folderId, card_id: "outline-050" }, context);
    const fullValue = JSON.parse((fullDirect.content[0] as { text: string }).text) as Record<string, unknown>;
    expect(fullValue).not.toHaveProperty("view");
    expect(fullValue).not.toHaveProperty("totalCards");
    expect(fullValue.cards).toMatchObject([{ id: "outline-050", request: "짧은 요청", brief: "짧은 경과" }]);

    const missingDirect = await call("get_folder", {
      folder_id: folderId, view: "outline", card_id: "missing-card", include_archived: false, limit: 50, cursor: "50",
    }, context);
    expect(missingDirect.structuredContent).toMatchObject({
      view: "outline", includeArchived: true, totalCards: 0, returnedCount: 0, nextCursor: null, cards: [],
    });

    const empty = await call("get_folder", { folder_id: "outline-empty", view: "outline" }, context);
    expect(empty.structuredContent).toMatchObject({ view: "outline", includeArchived: false, totalCards: 0, returnedCount: 0, nextCursor: null, cards: [] });
    expect((await call("get_folder", { folder_id: "missing", view: "outline" }, context)).structuredContent)
      .toEqual({ result: null });
    for (const options of [{ limit: 0 }, { limit: 51 }, { cursor: "-1" }]) {
      const invalid = await call("get_folder", { folder_id: folderId, view: "outline", ...options }, context);
      expect(invalid.isError).toBe(true);
    }
  }, 60_000);
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
