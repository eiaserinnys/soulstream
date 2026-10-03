import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cardTools } from "@soulstream/mcp-contract";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema, appendCardEventTx } from "./card-work-postgres-fixture.js";
import { unusedClusterDependencies } from "./mcp-cluster-unused-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { registerMcpHostRoutes } from "../src/mcp/mcp_host_routes.js";

// Same real PostgreSQL, mutation callback and dispatcher pattern as card-comments.postgres.test.ts.
describe("external MCP card writes", () => {
  let h: PagePostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  const messages = vi.fn(async (..._args: unknown[]) => {}), notify = vi.fn(async () => {}), warnings = vi.fn();
  const context = { principal: "external", caller_session_id: "forged-header", node_id: "orch" };
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":1}}','migration')`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined,
      change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(async () => sql), cards: async () => cards,
      resolveTarget: () => ({ nodeId: "node", agentId: "roselin", modelPreset: null, available: true, reason: null }),
      launch: async () => {}, sendMessage: messages, notify, warn: warnings });
    app = Fastify();
    registerMcpHostRoutes(app, { ...unusedClusterDependencies, board: undefined as never,
      authBearerToken: "token", folders: undefined as never, cards: {
        cardServiceProvider: async () => cards,
        provider: { listFolders: async () => [{ id: "a" }, { id: "b" }], listSessionAssignments: () => ({}) },
        resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }),
      } });
  }, 60_000);
  afterAll(async () => { await dispatcher?.drain(); await app?.close(); await h?.cleanup(); });
  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`TRUNCATE folders,sessions,folder_operations RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('a','A'),('b','B')`;
    await h.sql`INSERT INTO sessions(session_id,node_id,status) VALUES ('owner','node','running')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      VALUES ('card','a','a0','대상','원문','todo','session','owner')`;
    messages.mockClear(); notify.mockClear(); warnings.mockClear();
  });
  async function call(tool: string, args: object) {
    const response = await app.inject({ method: "POST", url: `/api/mcp/host/${tool}`,
      headers: { authorization: "Bearer token" }, payload: { args, context } });
    expect(response.statusCode).toBe(200);
    await dispatcher.drain();
    return response.json();
  }
  it("lists exactly the eight external writes while retaining internal work start", () => {
    const writes = ["create_card", "update_card_brief", "add_card_report", "add_card_comment", "set_card_status",
      "request_card_review", "ask_card_question", "move_card"] as const;
    expect(writes.map(name => cardTools[name].audience)).toEqual(writes.map(() => "all"));
    expect(cardTools.start_card_work.audience).toBe("internal");
  });
  it.each([
    ["create_card", { folder_id: "a", title: "외부 카드", request: "원문" }, "create_card"],
    ["update_card_brief", { card_id: "card", brief: "닷 경과" }, "update_card"],
    ["add_card_report", { card_id: "card", title: "보고", format: "markdown", body: "증거" }, "add_card_report"],
    ["request_card_review", { card_id: "card" }, "set_card_status"],
    ["move_card", { card_id: "card", folder_id: "b" }, "move_card"],
  ])("executes %s as llm without a caller session", async (tool, args, operation) => {
    const result = await call(tool as string, { ...(args as object), caller_session_id: "forged-argument" });
    expect(result.isError).not.toBe(true);
    expect(await h.sql`SELECT actor_kind,actor_session_id FROM folder_operations WHERE operation_type=${operation as string}`)
      .toEqual([expect.objectContaining({ actor_kind: "llm", actor_session_id: null })]);
    if (tool === "create_card") expect(await h.sql`SELECT title,created_session_id FROM cards WHERE title='외부 카드'`)
      .toEqual([expect.objectContaining({ title: "외부 카드", created_session_id: null })]);
    if (tool === "update_card_brief") expect((await cards.getCard("card"))!.card.brief).toBe("닷 경과");
    if (tool === "add_card_report") expect((await cards.getCard("card"))!.reports[0]).toMatchObject({ body: "증거", session_id: null });
    if (tool === "request_card_review") expect((await cards.getCard("card"))!.card.status).toBe("review");
    if (tool === "move_card") expect((await cards.getCard("card"))!.card.folder_id).toBe("b");
    expect(warnings).not.toHaveBeenCalled();
  });
  it.each(["todo", "queued", "running", "review", "blocked", "cancelled", "done"])("allows llm status %s", async status => {
    const result = await call("set_card_status", { card_id: "card", status, expected_version: 1,
      idempotency_key: `llm-${status}`, caller_session_id: "forged-argument" });
    expect(result.isError).not.toBe(true);
    expect((await cards.getCard("card"))!.card).toMatchObject({ status, updated_session_id: null,
      completed_kind: status === "done" ? "llm" : null, completed_session_id: null });
    expect((await h.sql`SELECT actor_kind,actor_session_id FROM folder_operations`)[0])
      .toMatchObject({ actor_kind: "llm", actor_session_id: null });
  });
  it("stores a user comment and delivers once with llm audit attribution", async () => {
    const result = await call("add_card_comment", { card_id: "card", text: "닷 사용자 지시" });
    expect(result.isError).not.toBe(true);
    const detail = (await cards.getCard("card"))!;
    expect(detail.comments[0]).toMatchObject({ author_kind: "user", author_id: null, session_id: null, kind: "comment",
      body: "닷 사용자 지시", delivered_at: expect.any(Date) });
    expect((await h.sql`SELECT actor_kind,actor_session_id FROM folder_operations`)[0])
      .toMatchObject({ actor_kind: "llm", actor_session_id: null });
    expect(messages).toHaveBeenCalledOnce();
    expect(messages).toHaveBeenCalledWith("owner", expect.stringContaining("닷 사용자 지시"), undefined,
      expect.objectContaining({ actorKind: "llm", actorSessionId: null }));
    expect(warnings).not.toHaveBeenCalled();
  });
  it.each(["spoken", "reply"])("rejects explicit external comment mode %s", async mode => {
    const result = await call("add_card_comment", { card_id: "card", text: "지시", mode });
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("Only trusted session actors may select a comment mode") }] });
    expect((await cards.getCard("card"))!.comments).toEqual([]);
  });
  it("records a null-session question, notifies the user, and stores the answer without external push or errors", async () => {
    const result = await call("ask_card_question", { card_id: "card", text: "닷 질문", options: ["진행", "대기"] });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.guidance).toBe("질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
    const question = (await cards.getCard("card"))!.questions[0]!;
    expect(question).toMatchObject({ session_id: null, text: "닷 질문", options: ["진행", "대기"] });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card", kind: "question", question: "닷 질문" }));
    messages.mockClear();
    await cards.answerQuestion({ actorKind: "user", actorUserId: "director", actorSessionId: null, cardId: "card", questionId: String(question.id), answer: "진행" });
    await dispatcher.drain(); await dispatcher.drain();
    expect((await cards.getCard("card"))!.questions[0]).toMatchObject({ answer: "진행", session_id: null });
    // Existing null-question-session handling requeues the card after unblocking.
    // Both state notices go to the assignee; neither sends the question answer to an external caller.
    expect(messages.mock.calls).toEqual([
      ["owner", expect.stringContaining("막힘→실행 중"), undefined, expect.any(Object)],
      ["owner", expect.stringContaining("실행 중→대기"), undefined, expect.any(Object)],
    ]);
    expect((await cards.getCard("card"))!.card.status).toBe("queued");
    expect(warnings).not.toHaveBeenCalled();
  });
  it("keeps start_card_work restricted to an agent", async () => {
    const result = await call("start_card_work", { card_id: "card", expected_version: 1, idempotency_key: "work" });
    expect(result.isError).toBe(true);
    expect((await cards.getCard("card"))!.card.status).toBe("todo");
  });
});
