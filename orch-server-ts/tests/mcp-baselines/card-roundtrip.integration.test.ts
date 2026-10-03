import { unusedClusterDependencies } from "../../../orch-server-ts/tests/mcp-cluster-unused-fixture.js";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
import { appendCardEventTx, prepareCardWorkSchema } from "../../../orch-server-ts/tests/card-work-postgres-fixture.js";
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };
import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";
import { createLiveDashboardAccessProvider, serviceTokenAccessWithoutEmail } from "../../../orch-server-ts/src/runtime/live_dashboard_access_provider.js";

const context: McpRequestContext = { callerSessionId: "header-session" };
const external: McpRequestContext = { ...context, principal: { authority: "external", source: "llm", displayName: "External" } };
const status = { card_id: "card-1", expected_version: 1, idempotency_key: "status-key" };
const execution = { registrationId: "registration", executionCommandId: "command" };
// Reuses the folder roundtrip SDK/HTTP/PG harness and card-work-start's real schema setup.
const cases: readonly [string, string, Record<string, unknown>, McpRequestContext?, boolean?][] = [["external query", "get_card", { card_id: "card-1", caller_session_id: "argument-session" }, external]];

describe("card orchestrator MCP roundtrip", () => {
  let h: PagePostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let executionOptions: McpHostOptions;
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
    executionOptions = { ...unusedClusterDependencies, board: undefined as never, authBearerToken: options.authBearerToken,
      cards: { ...options, resolveAccess: serviceTokenAccessWithoutEmail }, folders: {
      authBearerToken: options.authBearerToken, serviceProvider: async () => { throw new Error("unused folder host"); },
    } } as unknown as McpHostOptions;
    registerMcpHostRoutes(app, executionOptions);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer service-token" } };
    const logger = { warn: vi.fn() } as never;
  }, 60_000);
  afterAll(async () => { await app?.close(); await h?.cleanup(); });
  async function seed() {
    // Only the disposable harness's isolated schema is cleared; retain schema and policy.
    await h.sql`TRUNCATE folders,sessions,folder_operations RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('cards-a','A'),('cards-b','B'),('claude','System')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status,execution_registration_id,execution_command_id)
      VALUES ('header-session','test-node','roselin','sol','running','registration','command'),('argument-session','test-node',NULL,NULL,'running',NULL,NULL)`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,assignee_kind,assignee_session_id,status,completed_at)
      VALUES ('card-1','cards-a','a0','기존 카드','원문','session','header-session','todo',NULL),
      ('card-done','cards-a','a1','완료 카드','완료 원문','session','argument-session','done','2026-10-01T00:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id) VALUES('seed-report','card-1','기존 보고','markdown','본문','header-session')`;
    await h.sql`INSERT INTO card_comments(id,card_id,session_id,author_kind,kind,body) VALUES('seed-comment','card-1','header-session','user','spoken','기존 발언')`;
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text,options) VALUES('seed-question','card-1','header-session','기존 질문',NULL)`;
    await h.sql`UPDATE sessions SET card_id='card-1' WHERE session_id='header-session'`;
  }
  async function call(name: string, input: object, requestContext: McpRequestContext) {
    const value = await executeMcpTool(executionOptions, name as never, input as Record<string, unknown>, { principal: "external", callerSessionId: null, nodeId: "test-node" });
    const { isError, content, structuredContent, ...rest } = value;
    return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) };
  }
  it("allows external report writes with an llm audit actor", async () => {
    const input = { card_id: "card-1", title: "외부", format: "markdown", body: "보고" };
    await seed();
    expect((await call("add_card_report", input, external)).isError).not.toBe(true);
    expect((await h.sql`SELECT actor_kind,actor_session_id FROM folder_operations WHERE operation_type='add_card_report'`)[0])
      .toMatchObject({ actor_kind: "llm", actor_session_id: null });
  });
  it.each(cases.filter(row => row.includes(external)))("preserves %s", async (_label, name, input, requestContext = context, fails = false) => {
    await seed(); const next = await call(name, input, requestContext);
    expect(next.isError === true).toBe(fails);
    expect(serializeResult(name, next)).toMatchSnapshot();
    if (_label === "create success") expect((await h.sql`SELECT * FROM cards WHERE title='새 카드'`)[0]).toMatchObject({ assignee_kind: "agent", assignee_agent_id: "roselin", node_id: "test-node", model_preset: "sol" });
    if (_label === "create duplicate assignee") expect(JSON.stringify(next)).toContain("card-1");
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
