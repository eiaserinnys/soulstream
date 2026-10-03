import { unusedClusterDependencies } from "../../../orch-server-ts/tests/mcp-cluster-unused-fixture.js";
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
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };
import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";

const external: McpRequestContext = { principal: { authority: "external", source: "llm", displayName: "External" } };
const folderId = "00000000-0000-4000-8000-000000000001";
const mutation = { folder_id: folderId, expected_version: 1, idempotency_key: "tool-change" };
const cases = [];

// Actual SDK, host routes, services and disposable PG, as in page-roundtrip.integration.test.ts.
describe("folder object orchestrator MCP roundtrip", () => {
  let h: PagePostgresHarness;
  let identity: FolderProjectIdentityService;
  let app: ReturnType<typeof Fastify>;
  let executionOptions: McpHostOptions;
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
    executionOptions = { ...unusedClusterDependencies, board: undefined as never, authBearerToken: options.authBearerToken, folders: options, cards: {
      cardServiceProvider: options.cardServiceProvider, provider: { listFolders: () => [], listSessionAssignments: () => ({}) },
      resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }),
    } } as unknown as McpHostOptions;
    registerMcpHostRoutes(app, executionOptions);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer service-token" } };
    const logger = { warn: vi.fn() } as never;
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
    const value = await executeMcpTool(executionOptions, name as never, input as Record<string, unknown>, { principal: "external", callerSessionId: null, nodeId: "test-node" });
    const { isError, content, structuredContent, ...rest } = value;
    return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) };
  }

  async function roundtrip(name: string, input: object, requestContext = context) {
    await seed(); const next = await call(name, input, requestContext);
    expect(serializeResult(name, next)).toMatchSnapshot();
    return next;
  }

  it("preserves llm actor for external callers and ignores both session IDs", async () => {
    const result = await roundtrip("create_folder", { name: "외부", idempotency_key: "external", caller_session_id: "argument-session" }, {
      ...context, principal: { authority: "external", source: "llm", displayName: "External" },
    });
    expect(result.structuredContent).toMatchObject({ operation: { actorKind: "llm", actorSessionId: null } });
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
});
