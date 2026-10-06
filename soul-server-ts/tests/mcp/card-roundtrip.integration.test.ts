import { unusedClusterDependencies } from "../../../orch-server-ts/tests/mcp-cluster-unused-fixture.js";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CardControlPlaneService } from "../../../orch-server-ts/src/cards/card_control_plane_service.js";
import { createBoardYjsSqlAdapter } from "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
import { appendCardEventTx, prepareCardWorkSchema } from "../../../orch-server-ts/tests/card-work-postgres-fixture.js";
import { registerFolderControlPlaneHostRoute } from "../../../orch-server-ts/src/folders/folder_control_plane_host_route.js";
import { sessionTools } from "@soulstream/mcp-contract";
import { SessionDB } from "../../src/db/session_db.js";
import { FolderHostClient } from "../../src/folder/folder_host_client.js";
import { registerOrchestratorTools } from "../../src/mcp/orchestrator_tools.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { createInventoryMcpServer } from "../../src/mcp/tool_access.js";
import { registerCardTools } from "../../src/mcp/tools/card_tools.js";
import { createLiveDashboardAccessProvider, serviceTokenAccessWithoutEmail } from "../../../orch-server-ts/src/runtime/live_dashboard_access_provider.js";

const context: McpRequestContext = { callerSessionId: "header-session" };
const status = { card_id: "card-1", expected_version: 1, idempotency_key: "status-key" };
const execution = { registrationId: "registration", executionCommandId: "command" };
const successorExecution = { registrationId: "successor-registration", executionCommandId: "successor-command" };
// Reuses the folder roundtrip SDK/HTTP/PG harness and card-work-start's real schema setup.
const cases: readonly [string, string, Record<string, unknown>, McpRequestContext?, boolean?][] = [
  ["create success", "create_card", { folder_id: "cards-a", title: "새 카드", request: "원문", queue: true,
    attachments: [{ nodeId: "node", path: "image.png", name: "이미지", mimeType: "image/png" }] }],
  ["create duplicate assignee", "create_card", { folder_id: "cards-a", title: "새 카드", request: "원문", queue: true,
    assignee: { kind: "session", session_id: "header-session" },
    attachments: [{ nodeId: "node", path: "image.png", name: "이미지", mimeType: "image/png" }] }, context, true],
  ["list all", "list_cards", {}],
  ["list folder", "list_cards", { folder_id: "cards-a" }],
  ["list status", "list_cards", { status: "todo" }],
  ["list done", "list_cards", { status: "done" }],
  ["get success", "get_card", { card_id: "card-1" }],
  ["assignee handoff", "transfer_card_assignee", { card_id: "card-1", target_session_id: "successor-session",
    expected_version: 1, idempotency_key: "handoff-key", reason: "successor takes over" }],
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
  ["internal no session", "update_card_brief", { card_id: "card-1", brief: "경과" }, {}, true],
  ["status mismatch", "set_card_status", { ...status, status: "done", caller_session_id: "argument-session" }, context, true],
  ["reply mismatch", "add_card_comment", { card_id: "card-1", text: "답변", mode: "reply", caller_session_id: "argument-session" }, context, true],
  ["work mismatch", "start_card_work", { ...status, caller_session_id: "argument-session" }, context, true],
  ["work no execution", "start_card_work", status, { callerSessionId: "argument-session" }, true],
];

describe("card orchestrator MCP roundtrip", () => {
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
    // The folder host route is where the worker's number lookup lands; sessions back get_session_summary.
    registerFolderControlPlaneHostRoute(app, { authBearerToken: options.authBearerToken,
      serviceProvider: async () => ({}) as never, cardServiceProvider: async () => cards });
    registerMcpHostRoutes(app, { ...unusedClusterDependencies, board: undefined as never, authBearerToken: options.authBearerToken,
      cards: { ...options, resolveAccess: serviceTokenAccessWithoutEmail }, folders: {
      authBearerToken: options.authBearerToken, serviceProvider: async () => { throw new Error("unused folder host"); },
    }, sessions: { repositoryProvider: async () => ({
      sessionReads: { getSession: async (id: string) => (await h.sql`SELECT * FROM sessions WHERE session_id=${id}`)[0] ?? null },
      sessionReadComposites: { getTurnExcerpt: async () => ({ totalEvents: 0, turns: [] }) },
      deliveries: { recordObservedChildCompletions: async () => ({ status: "recorded" }) },
    }) } as never });
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer service-token" } };
    const logger = { warn: vi.fn() } as never;
    const db = new SessionDB();
    db.configureFolderHost(new FolderHostClient({ orch, logger }));
    runtime = { nodeId: "test-node", orch, logger, db, taskManager: { getTask: (id: string) =>
      id === "header-session" ? { executionRegistration: execution }
        : id === "successor-session" ? { executionRegistration: successorExecution } : undefined } } as unknown as McpRuntime;
  }, 60_000);
  afterAll(async () => { await app?.close(); await h?.cleanup(); });
  async function seed() {
    // Only the disposable harness's isolated schema is cleared; retain schema and policy.
    await h.sql`TRUNCATE folders,sessions,folder_operations RESTART IDENTITY CASCADE`;
    await h.sql`ALTER SEQUENCE cards_number_seq RESTART WITH 1`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('cards-a','A'),('cards-b','B'),('claude','System')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,agent_id,model_preset,status,execution_registration_id,execution_command_id)
      VALUES ('header-session','test-node','roselin','sol','running','registration','command'),
      ('argument-session','test-node',NULL,NULL,'running',NULL,NULL),
      ('successor-session','test-node','roselin','sol','running','successor-registration','successor-command')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,assignee_kind,assignee_session_id,status,completed_at)
      VALUES ('card-1','cards-a','a0','기존 카드','원문','session','header-session','todo',NULL),
      ('card-done','cards-a','a1','완료 카드','완료 원문','session','argument-session','done','2026-10-01T00:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id) VALUES('seed-report','card-1','기존 보고','markdown','본문','header-session')`;
    await h.sql`INSERT INTO card_comments(id,card_id,session_id,author_kind,kind,body) VALUES('seed-comment','card-1','header-session','user','spoken','기존 발언')`;
    await h.sql`INSERT INTO card_questions(id,card_id,session_id,text,options) VALUES('seed-question','card-1','header-session','기존 질문',NULL)`;
    await h.sql`UPDATE sessions SET card_id='card-1' WHERE session_id='header-session'`;
  }
  async function call(name: string, input: object, requestContext: McpRequestContext) {
    const server = new McpServer({ name: "parity", version: "1" });
    // Through the worker's real proxy, so every full-ID case below also proves they are unchanged by it.
    const guarded = createInventoryMcpServer(server, runtime);
    registerCardTools(guarded, runtime);
    registerOrchestratorTools(guarded, runtime, [sessionTools.get_session_summary]);
    const client = new Client({ name: "parity-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      return await withMcpRequestContext(requestContext, () => client.callTool({ name, arguments: input as Record<string, unknown> }));
    } finally { await client.close(); await server.close(); }
  }
  it.each(cases)("preserves %s", async (_label, name, input, requestContext = context, fails = false) => {
    await seed(); const next = await call(name, input, requestContext);
    expect(next.isError === true).toBe(fails);
    expect(serializeResult(name, next)).toMatchSnapshot();
    if (_label === "create success") expect((await h.sql`SELECT * FROM cards WHERE title='새 카드'`)[0]).toMatchObject({ assignee_kind: "agent", assignee_agent_id: "roselin", node_id: "test-node", model_preset: "sol" });
    if (_label === "create duplicate assignee") expect(JSON.stringify(next)).toContain("card-1");
    if (name === "ask_card_question" && !fails) expect(next.structuredContent).toHaveProperty("guidance", "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
  });
  it("roundtrips the check-item tools, user comment target, notes, and situation history",async()=>{
    await seed();
    const set=await call("set_card_items",{card_id:"card-1",items:[{title:"가입 화면 확인"}]},context);
    expect(set.isError).not.toBe(true);
    expect(set.structuredContent).toMatchObject({card:{id:"card-1",number:1,version:2,status:"todo"},
      items:[{id:1,title:"가입 화면 확인",state:"todo"}]});
    const report=await call("report_card_item",{card_id:"card-1",item_id:1,state:"done",result:"가입 뒤 다음 화면이 열립니다",
      evidence:[{type:"link",url:"https://example.test/join",label:"가입 화면"}]},context);
    expect(report.isError).not.toBe(true);
    expect(report.structuredContent).toMatchObject({card:{id:"card-1",number:1,version:3,status:"todo"},
      item:{id:1,title:"가입 화면 확인",state:"done"}});
    const added=await call("add_card_item",{card_id:"card-1",title:"안내 문구 확인",from_comment_id:"seed-comment"},context);
    expect(added.isError).not.toBe(true);
    expect(added.structuredContent).toMatchObject({card:{id:"card-1",number:1,version:4,status:"todo"},
      item:{id:2,title:"안내 문구 확인",state:"todo"}});
    const comment=await call("add_card_comment",{card_id:"card-1",text:"안내 문구를 고쳐 주세요",mode:"spoken",item_id:2},context);
    expect(comment.isError).not.toBe(true);
    expect(comment.structuredContent).toMatchObject({id:expect.any(String),itemId:2,kind:"spoken",authorKind:"user"});
    expect(comment.structuredContent).not.toHaveProperty("body");
    const now=await call("update_card_now",{card_id:"card-1",now:"수정 화면 확인을 기다립니다",turn:"user",ask:"수정 화면을 확인해 주세요"},context);
    expect(now.isError).not.toBe(true);
    expect(now.structuredContent).toMatchObject({card:{id:"card-1",number:1,version:6,status:"todo"}});
    const note=await call("add_card_note",{card_id:"card-1",text:"화면 주소와 구현 기록"},context);
    expect(note.isError).not.toBe(true);
    expect(note.structuredContent).toMatchObject({id:expect.any(String),createdAt:expect.any(String)});
    expect(note.structuredContent).not.toHaveProperty("body");
    const notes=await call("list_card_notes",{card_id:"card-1",limit:20},context);
    expect(notes.isError).not.toBe(true);
    expect(notes.structuredContent).toMatchObject({notes:[{id:note.structuredContent?.id,kind:"note",body:"화면 주소와 구현 기록"}],nextCursor:null});
    const review=await call("request_card_review",{card_id:"card-1",ask:"가입과 수정 화면을 확인해 주세요"},context);
    expect(review.isError).not.toBe(true);
    const detail=await call("get_card",{card_id:"card-1"},context);
    expect(detail.isError).not.toBe(true);
    expect(detail.structuredContent).toMatchObject({
      card:{items:[{id:1,display:"reported"},{id:2,display:"fix",fixOpen:1}],now:{text:"수정 화면 확인을 기다립니다",turn:"user"}},
      comments:[expect.objectContaining({id:"seed-comment"}),expect.objectContaining({itemId:2,body:"안내 문구를 고쳐 주세요"})],
      reports:[expect.objectContaining({title:"기존 보고"})],notes:[expect.objectContaining({kind:"note",body:"화면 주소와 구현 기록"})],
      nowHistory:[expect.objectContaining({text:"수정 화면 확인을 기다립니다",turn:"user",ask:"수정 화면을 확인해 주세요"})],
    });
  });
  it("translates number references through the real central lookup and leaves full IDs unchanged", async () => {
    await seed();
    await h.sql`UPDATE sessions SET display_name='헤더 세션' WHERE session_id='header-session'`;
    const byId = await call("get_card", { card_id: "card-1" }, context);
    const byNumber = await call("get_card", { card_id: "#1" }, context);
    expect(byNumber.isError, JSON.stringify(byNumber.content)).not.toBe(true);
    expect(byNumber.content[0]).toEqual({ type: "text", text: "번호 참조 #1 → 카드 「기존 카드」" });
    expect(byNumber.content.slice(1)).toEqual(byId.content);
    expect(byNumber.structuredContent).toMatchObject({ resolved_references: ["번호 참조 #1 → 카드 「기존 카드」"] });
    expect(Object.fromEntries(Object.entries(byNumber.structuredContent!).filter(([key]) => key !== "resolved_references")))
      .toEqual(byId.structuredContent);
    expect(byId.content[0]).not.toMatchObject({ text: expect.stringContaining("번호 참조") });

    const summary = await call("get_session_summary", { session_id: "#1.s1" }, context);
    expect(summary.isError).not.toBe(true);
    expect(summary.content[0]).toEqual({ type: "text", text: "번호 참조 #1.s1 → 세션 「헤더 세션」" });
    expect(summary.structuredContent).toMatchObject({ resolved_references: ["번호 참조 #1.s1 → 세션 「헤더 세션」"] });
    expect(summary.structuredContent).toMatchObject({ session_id: "header-session", display_name: "헤더 세션" });
    const fullSessionId = await call("get_session_summary", { session_id: "header-session" }, context);
    expect(Object.fromEntries(Object.entries(summary.structuredContent!).filter(([key]) => key !== "resolved_references")))
      .toEqual(fullSessionId.structuredContent);

    const missing = await call("get_card", { card_id: "#9999" }, context);
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("#9999 번호의 카드가 없습니다.");
    const noSession = await call("get_session_summary", { session_id: "#1.s5" }, context);
    expect(noSession.isError).toBe(true);
    expect(JSON.stringify(noSession.content)).toContain("카드 #1에 붙은 세션은 1개입니다");
  });
  it("returns number: null for an archived card that never had a number when called by full ID", async () => {
    await seed();
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,assignee_kind,status,archived,number)
      VALUES ('archived-card','cards-a','a9','번호 없는 보관 카드','원문','human','done',TRUE,NULL)`;
    const result = await call("get_card", { card_id: "archived-card" }, context);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ card: { id: "archived-card", number: null, archived: true } });
    expect(JSON.stringify(result.content)).not.toContain("번호 참조");
  });
  it("supports handoff by a new internal session after the prior assignee stops", async () => {
    await seed();
    await h.sql`UPDATE sessions SET status='interrupted',execution_registration_id=NULL,execution_command_id=NULL
      WHERE session_id='header-session'`;
    const successorContext = { callerSessionId: "successor-session" };
    const handoff = { card_id: "card-1", target_session_id: "successor-session", expected_version: 1,
      idempotency_key: "successor-handoff", reason: "successor takes over" };
    const transferred = await call("transfer_card_assignee", handoff, successorContext);
    expect(transferred.isError).not.toBe(true);
    expect(await h.sql`SELECT assignee_session_id,status,version,updated_session_id FROM cards WHERE id='card-1'`)
      .toEqual([expect.objectContaining({ assignee_session_id: "successor-session", status: "todo", version: 2, updated_session_id: "successor-session" })]);
    expect(await h.sql`SELECT operation_type,actor_session_id,idempotency_key FROM folder_operations WHERE idempotency_key='successor-handoff'`)
      .toEqual([expect.objectContaining({ operation_type: "update_card", actor_session_id: "successor-session", idempotency_key: "successor-handoff" })]);

    const replay = await call("transfer_card_assignee", handoff, successorContext);
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({ idempotent: true });
    const stale = await call("transfer_card_assignee", { ...handoff, idempotency_key: "stale-handoff" }, successorContext);
    expect(stale.isError).toBe(true);

    const oldStatus = await call("set_card_status", { card_id: "card-1", status: "running", expected_version: 2,
      idempotency_key: "old-status" }, context);
    expect(oldStatus.isError).toBe(true);
    expect(JSON.stringify(oldStatus)).toContain("transfer_card_assignee");
    const oldReply = await call("add_card_comment", { card_id: "card-1", text: "이전 담당의 답변", mode: "reply" }, context);
    expect(oldReply.isError).toBe(true);
    expect(JSON.stringify(oldReply)).toContain("transfer_card_assignee");

    const started = await call("start_card_work", { card_id: "card-1", expected_version: 2, idempotency_key: "successor-start" }, successorContext);
    expect(started.isError).not.toBe(true);
    const statusChanged = await call("set_card_status", { card_id: "card-1", status: "review", expected_version: 3,
      idempotency_key: "successor-status" }, successorContext);
    expect(statusChanged.isError).not.toBe(true);
    const replied = await call("add_card_comment", { card_id: "card-1", text: "새 담당의 답변", mode: "reply" }, successorContext);
    expect(replied.isError).not.toBe(true);
    expect(await h.sql`SELECT author_kind,session_id,body FROM card_comments WHERE body='새 담당의 답변'`)
      .toEqual([expect.objectContaining({ author_kind: "agent", session_id: "successor-session", body: "새 담당의 답변" })]);
  });
  it("retains target-session FK and one-card validation on handoff", async () => {
    await seed();
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,assignee_kind,assignee_session_id,status)
      VALUES ('successor-card','cards-a','a2','이미 맡은 카드','원문','session','successor-session','todo')`;
    const occupied = await call("transfer_card_assignee", { card_id: "card-1", target_session_id: "successor-session",
      expected_version: 1, idempotency_key: "occupied-handoff" }, context);
    expect(occupied.isError).toBe(true);
    expect(JSON.stringify(occupied)).toContain("successor-card");
    expect(await h.sql`SELECT assignee_session_id FROM cards WHERE id='card-1'`)
      .toEqual([expect.objectContaining({ assignee_session_id: "header-session" })]);

    const missing = await call("transfer_card_assignee", { card_id: "card-1", target_session_id: "missing-session",
      expected_version: 1, idempotency_key: "missing-handoff" }, context);
    expect(missing.isError).toBe(true);
    expect(await h.sql`SELECT assignee_session_id FROM cards WHERE id='card-1'`)
      .toEqual([expect.objectContaining({ assignee_session_id: "header-session" })]);
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
  set_card_items: ["operation.id","operation.idempotencyKey"],
  add_card_item: ["operation.id","operation.idempotencyKey"],
  report_card_item: ["operation.id","operation.idempotencyKey"],
  update_card_now: ["operation.id","operation.idempotencyKey"],
  add_card_note: ["id"],
  list_card_notes: ["notes.0.id"],
  // card_control_plane_service.ts:120,131; response is the stored comment, not the audit envelope.
  add_card_comment: ["id"],
  set_card_status: ["operation.id"],
  start_card_work: ["operation.id"],
  transfer_card_assignee: ["operation.id"],
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
describe("card result masking", () => {
  it("masks only listed random fields and timestamps", () => {
    expect(mask("set_card_status", { operation: { id: "random", createdAt: "now" }, card: { id: "card-1" } }))
      .toEqual({ operation: { id: "<random-id>", createdAt: "<time>" }, card: { id: "card-1" } });
    expect(mask("get_card", { id: "seed", completed_at: null })).toEqual({ id: "seed", completed_at: null });
  });
});
