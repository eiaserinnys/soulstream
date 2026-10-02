import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { registerCardRoutes } from "../../../orch-server-ts/src/cards/card_routes.js";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
import { appendCardEventTx, prepareCardWorkSchema } from "../../../orch-server-ts/tests/card-work-postgres-fixture.js";
import { FolderService } from "../../src/folder/folder_service.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerCardTools, registerCardToolsLegacy } from "../../src/mcp/tools/card_tools.js";
import { createLiveDashboardAccessProvider, serviceTokenAccessWithoutEmail } from "../../../orch-server-ts/src/runtime/live_dashboard_access_provider.js";

const context: McpRequestContext = { callerSessionId: "header-session" };
const external: McpRequestContext = { ...context, principal: { authority: "external", source: "llm", displayName: "External" } };
const status = { card_id: "card-1", expected_version: 1, idempotency_key: "status-key" };
const execution = { registrationId: "registration", executionCommandId: "command" };
// Reuses the folder roundtrip SDK/HTTP/PG harness and card-work-start's real schema setup.
const cases: readonly [string, string, Record<string, unknown>, McpRequestContext?, boolean?][] = [
  ["create success", "create_card", { folder_id: "cards-a", title: "새 카드", request: "원문", queue: true,
    assignee: { kind: "session", session_id: "header-session" }, node_id: "test-node", model_preset: "sol",
    attachments: [{ nodeId: "node", path: "image.png", name: "이미지", mimeType: "image/png" }] }],
  ["list all", "list_cards", {}],
  ["list folder", "list_cards", { folder_id: "cards-a" }],
  ["list status", "list_cards", { status: "todo" }],
  ["list done", "list_cards", { status: "done" }],
  ["get success", "get_card", { card_id: "card-1" }],
  ["brief success", "update_card_brief", { card_id: "card-1", brief: "경과" }],
  ["report success", "add_card_report", { card_id: "card-1", title: "보고", format: "html", body: "<p>증거</p>" }],
  ["comment default spoken", "add_card_comment", { card_id: "card-1", text: "사용자 발언" }],
  ["comment reply", "add_card_comment", { card_id: "card-1", text: "에이전트 답변", mode: "reply" }],
  ["status success", "set_card_status", { ...status, status: "running" }],
  ["work success", "start_card_work", status],
  ["review success", "request_card_review", { card_id: "card-1" }],
  ["question options", "ask_card_question", { card_id: "card-1", text: "판단?", options: ["진행", "중단"] }],
  ["question no options", "ask_card_question", { card_id: "card-1", text: "판단?" }],
  ["move success", "move_card", { card_id: "card-1", folder_id: "cards-b", after_card_id: null }],
  ["get missing", "get_card", { card_id: "missing" }, context, true],
  ["mutation missing", "update_card_brief", { card_id: "missing", brief: "경과" }, context, true],
  ["version conflict", "set_card_status", { ...status, status: "done", expected_version: 999 }, context, true],
  ["system create", "create_card", { folder_id: "claude", title: "시스템", request: "" }, context, true],
  ["system move", "move_card", { card_id: "card-1", folder_id: "claude" }, context, true],
  ["external mutation", "add_card_report", { card_id: "card-1", title: "외부", format: "markdown", body: "" }, external, true],
  ["external query", "get_card", { card_id: "card-1", caller_session_id: "argument-session" }, external],
  ["internal no session", "update_card_brief", { card_id: "card-1", brief: "경과" }, {}, true],
  ["status mismatch", "set_card_status", { ...status, status: "done", caller_session_id: "argument-session" }, context, true],
  ["reply mismatch", "add_card_comment", { card_id: "card-1", text: "답변", mode: "reply", caller_session_id: "argument-session" }, context, true],
  ["work mismatch", "start_card_work", { ...status, caller_session_id: "argument-session" }, context, true],
  ["work no execution", "start_card_work", status, { callerSessionId: "argument-session" }, true],
];

describe("card legacy and orchestrator MCP parity", () => {
  let h: PagePostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let runtime: McpRuntime;
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql.unsafe(await readFile(new URL("../../../packages/db-schema/sql/migrations/113_card_orchestration.sql", import.meta.url), "utf8"));
    const cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx }, {
      emitFolderUpdated: async () => {}, emitCardUpdated: async () => {},
    });
    const options = { cardServiceProvider: async () => cards,
      provider: { listFolders: async () => [{ id: "cards-a" }, { id: "cards-b" }, { id: "claude" }], listSessionAssignments: () => ({}) },
      accessProvider: createLiveDashboardAccessProvider({ configProvider: {
        getConfig: async () => ({ auth_bearer_token: "service-token", environment: "production", google_client_id: "" }),
      } as never, jwt: { verifyToken: async () => null } as never, repository: { findUserByEmail: async () => null } }),
      authBearerToken: "service-token" };
    app = Fastify();
    registerCardRoutes(app, options);
    registerMcpHostRoutes(app, { board: undefined as never, authBearerToken: options.authBearerToken,
      cards: { ...options, resolveAccess: serviceTokenAccessWithoutEmail }, folders: {
      authBearerToken: options.authBearerToken, serviceProvider: async () => { throw new Error("unused folder host"); },
    } });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer service-token" } };
    const logger = { warn: vi.fn() } as never;
    runtime = { nodeId: "test-node", orch, logger, folderService: new FolderService({ orch, logger }),
      taskManager: { getTask: (id: string) => id === "header-session" ? { executionRegistration: execution } : undefined } } as unknown as McpRuntime;
  }, 60_000);
  afterAll(async () => { await app?.close(); await h?.cleanup(); });
  async function seed() {
    // Only the disposable harness's isolated schema is cleared; retain schema and policy.
    await h.sql`TRUNCATE folders,sessions,folder_operations RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('cards-a','A'),('cards-b','B'),('claude','System')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,status,execution_registration_id,execution_command_id)
      VALUES ('header-session','test-node','running','registration','command'),('argument-session','test-node','running',NULL,NULL)`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,assignee_kind,assignee_session_id,status,completed_at)
      VALUES ('card-1','cards-a','a0','기존 카드','원문','session','header-session','todo',NULL),
      ('card-done','cards-a','a1','완료 카드','완료 원문','session','header-session','done','2026-10-01T00:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id) VALUES('seed-report','card-1','기존 보고','markdown','본문','header-session')`;
    await h.sql`INSERT INTO card_comments(id,card_id,session_id,author_kind,kind,body) VALUES('seed-comment','card-1','header-session','user','spoken','기존 발언')`;
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text,options) VALUES('seed-question','card-1','header-session','기존 질문',NULL)`;
    await h.sql`UPDATE sessions SET card_id='card-1' WHERE session_id='header-session'`;
  }
  async function call(legacy: boolean, name: string, input: object, requestContext: McpRequestContext) {
    const server = new McpServer({ name: "parity", version: "1" });
    (legacy ? registerCardToolsLegacy : registerCardTools)(server, runtime);
    const client = new Client({ name: "parity-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await withMcpRequestContext(requestContext, () => client.callTool({ name, arguments: input as Record<string, unknown> }));
    } finally { await client.close(); await server.close(); }
  }
  it.each(cases)("preserves %s", async (_label, name, input, requestContext = context, fails = false) => {
    await seed(); const old = await call(true, name, input, requestContext);
    expect(old.isError === true).toBe(fails);
    await seed(); const next = await call(false, name, input, requestContext);
    assertParity(name, old, next);
    if (name === "ask_card_question" && !fails) expect(next.structuredContent).toHaveProperty("guidance", "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
  });
});

// Paths are relative to both parsed content JSON and structuredContent; seed IDs are never masked.
const randomIdPaths: Record<string, readonly string[]> = {
  // card_mutation_core.ts:74 audit UUID; FolderService:76,118 per-call idempotency UUID.
  // card_control_plane_service.ts:45 card UUID, repeated by serializeCardMutation in operation.targetId.
  create_card: ["card.id", "operation.targetId", "operation.id", "operation.idempotencyKey"],
  update_card_brief: ["operation.id", "operation.idempotencyKey"],
  // Reports/questions UUIDs (card_control_plane_service.ts:109,137) are stored but absent from mutation result.
  add_card_report: ["operation.id", "operation.idempotencyKey"],
  // card_control_plane_service.ts:120,131; response is the stored comment, not the audit envelope.
  add_card_comment: ["id"],
  set_card_status: ["operation.id"],
  start_card_work: ["operation.id"],
  request_card_review: ["operation.id", "operation.idempotencyKey"],
  ask_card_question: ["operation.id", "operation.idempotencyKey"],
  move_card: ["operation.id", "operation.idempotencyKey"],
};
function mask(tool: string, value: unknown, path: string[] = []): unknown {
  if (randomIdPaths[tool]?.includes(path.join("."))) return "<random-id>";
  if (Array.isArray(value)) return value.map((child, index) => mask(tool, child, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /_at$|At$/.test(key) && child !== null ? "<time>" : mask(tool, child, [...path, key]) ]));
}
function serializeResult(tool: string, result: unknown): string {
  const value = result as { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  return JSON.stringify({ ...value, content: value.content.map(item => {
    // A message-less 404 is the raw compact HTTP body. Compare error text verbatim, including whitespace.
    if (item.type !== "text" || value.isError) return item;
    let parsed: unknown;
    try { parsed = JSON.parse(item.text!); } catch { return item; }
    expect(item.text).toBe(JSON.stringify(parsed, null, 2));
    return { ...item, text: JSON.stringify(mask(tool, parsed), null, 2) };
  }), ...(value.structuredContent === undefined ? {} : { structuredContent: mask(tool, value.structuredContent) }) }, null, 2);
}
function assertParity(tool: string, old: unknown, next: unknown) { expect(serializeResult(tool, next)).toBe(serializeResult(tool, old)); }
describe("card parity comparator detects violations", () => {
  const result = (value: Record<string, unknown>, spaces = 2) => ({ content: [{ type: "text", text: JSON.stringify(value, null, spaces) }], structuredContent: value });
  it.each(["content", "structuredContent", "isError"])("detects changed %s", key => {
    const old = { content: [{ type: "text", text: "ok" }], structuredContent: { result: "ok" }, isError: false };
    expect(() => assertParity("get_card", old, { ...old, [key]: "broken" })).toThrow();
  });
  it("masks only listed random fields and timestamps", () => {
    assertParity("set_card_status", result({ operation: { id: "a", createdAt: "old" }, card: { id: "card-1" } }),
      result({ operation: { id: "b", createdAt: "new" }, card: { id: "card-1" } }));
  });
  it("detects structured key order", () => {
    const old = result({ id: "first", title: "card" });
    expect(() => assertParity("get_card", old, { ...old, structuredContent: { title: "card", id: "first" } })).toThrow();
  });
  it("detects JSON key order", () => { expect(() => assertParity("get_card", result({ id: "first", title: "card" }), result({ title: "card", id: "first" }))).toThrow(); });
  it("detects JSON indentation", () => { expect(() => assertParity("get_card", result({ id: "first" }), result({ id: "first" }, 4))).toThrow(); });
  it("detects unmasked IDs", () => { expect(() => assertParity("set_card_status", result({ card: { id: "card-1" } }), result({ card: { id: "card-2" } }))).toThrow(); });
  it("compares compact JSON error messages verbatim", () => {
    const body = { detail: { error: { code: "CARD_NOT_FOUND" } } };
    const old = { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
    assertParity("get_card", old, old);
    expect(() => assertParity("get_card", old, { ...old, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] })).toThrow();
  });
});
