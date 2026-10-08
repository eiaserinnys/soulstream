import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cardTools } from "@soulstream/mcp-contract";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { prepareCardWorkSchema, appendCardEventTx } from "./card-work-postgres-fixture.js";
import { unusedClusterDependencies } from "./mcp-cluster-unused-fixture.js";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { CardDispatchRepository } from "../src/cards/card_dispatch_repository.js";
import { CardDispatcher } from "../src/cards/card_dispatcher.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import type { CallToolResult } from "@soulstream/mcp-contract";

// Same real PostgreSQL, mutation callback and dispatcher pattern as card-comments.postgres.test.ts.
describe("external MCP card writes", () => {
  let h: PagePostgresHarness;
  let executionOptions: McpHostOptions;
  let cards: CardControlPlaneService;
  let dispatcher: CardDispatcher;
  const messages = vi.fn(async (..._args: unknown[]) => {}), notify = vi.fn(async () => {}), warnings = vi.fn();
  const context = { principal: "external" as const, callerSessionId: null, nodeId: "orch" };
  let access = { restricted: false, allowedFolderIds: [] as string[] };
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await prepareCardWorkSchema(h);
    await h.sql`CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,value JSONB NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT NOT NULL)`;
    await h.sql`INSERT INTO system_settings(setting_key,value,updated_by) VALUES ('card_dispatch','{"nodeConcurrency":{"default":1}}','migration')`;
    const sql = createBoardYjsSqlAdapter(h.liveSql);
    cards = new CardControlPlaneService(sql, { appendEventTx: appendCardEventTx }, undefined,
      change => dispatcher.acceptMutation(change));
    dispatcher = new CardDispatcher({ deliveryExists: async () => false, repository: new CardDispatchRepository(async () => sql), cards: async () => cards,
      resolveTarget: () => ({ nodeId: "node", agentId: "roselin", modelPreset: null, available: true, reason: null }),
      launch: async () => {}, sendMessage: messages, notify, warn: warnings });
    executionOptions = { ...unusedClusterDependencies, board: undefined as never,
      authBearerToken: "token", folders: undefined as never, cards: {
        cardServiceProvider: async () => cards,
        provider: { listFolders: async () => [{ id: "a" }, { id: "b" }], listSessionAssignments: () => ({}) },
        resolveAccess: () => access,
      } };
  }, 60_000);
  afterAll(async () => { await dispatcher?.drain(); await h?.cleanup(); });
  beforeEach(async () => {
    await dispatcher.drain();
    await h.sql`TRUNCATE folders,sessions,folder_operations RESTART IDENTITY CASCADE`;
    await h.sql`INSERT INTO folders(id,name) VALUES ('a','A'),('b','B')`;
    access = { restricted: false, allowedFolderIds: [] };
    await h.sql`INSERT INTO sessions(session_id,node_id,status) VALUES ('owner','node','running')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      VALUES ('card','a','a0','대상','원문','todo','session','owner')`;
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      VALUES ('card-b','b','a0','다른 폴더','다른 원문','todo','session','owner')`;
    messages.mockClear(); notify.mockClear(); warnings.mockClear();
  });
  async function call(tool: string, args: object) {
    const result: CallToolResult = await executeMcpTool(executionOptions, tool as keyof typeof cardTools, args as Record<string, unknown>, context);
    await dispatcher.drain();
    return result;
  }
  it("returns compact current state by default and restores only selected source pages", async () => {
    await h.sql`UPDATE cards SET brief='인계 요약',
      attachments='[{"nodeId":"node","path":"/incoming/file.txt","name":"file.txt","mimeType":"text/plain"}]'::jsonb,
      items='[{"id":1,"title":"결과 항목","state":"done","result":"저장 결과","evidence":[{"type":"link","url":"https://example.test/evidence","label":"근거"}],"rev":1,"confirmed":null,"fixOpen":0,"reopened":null}]'::jsonb
      WHERE id='card'`;
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at) VALUES
      ('read-comment','card','user','spoken','사용자 발언','2026-10-08T10:00:00Z'),
      ('read-note-older','card','agent','note','이전 작업 기록','2026-10-08T09:00:00Z'),
      ('read-note-newer','card','agent','note','최신 작업 기록','2026-10-08T10:00:00Z')`;
    await h.sql`INSERT INTO card_reports(id,card_id,title,format,body) VALUES('read-report','card','작업 보고','markdown','보고 전문')`;
    await h.sql`INSERT INTO card_questions(id,card_id,text,options) VALUES('read-question','card','미답 질문',NULL)`;

    const compact = await call("get_card", { card_id: "card", caller_session_id: "forged-session" });
    expect(compact.isError).not.toBe(true);
    expect(compact.structuredContent).toMatchObject({
      card: { id: "card", items: [{ title: "결과 항목", result: "저장 결과", evidence: [{ label: "근거" }] }] },
      questions: { items: [{ id: "read-question", text: "미답 질문", answer: null }], nextCursor: null, truncated: false },
      available: { request: true, brief: true, attachments: true, comments: 1, notes: 2, reports: 1 },
      changeToken: expect.any(String),
    });
    const compactText = JSON.stringify(compact.structuredContent);
    for (const omitted of ["원문", "인계 요약", "file.txt", "사용자 발언", "작업 기록", "보고 전문"])
      expect(compactText).not.toContain(omitted);

    const fullPages = await call("get_card", { card_id: "card", caller_session_id: "forged-session",
      include: ["request", "brief", "attachments", "comments", "notes", "reports"], limit: 1 });
    expect(fullPages.isError).not.toBe(true);
    const sections = (fullPages.structuredContent as { sections: Record<string, { text?: string; items?: Record<string, unknown>[]; nextCursor?: string | null; truncated?: boolean }> }).sections;
    expect(sections.request?.text).toBe("원문");
    expect(sections.brief?.text).toBe("인계 요약");
    expect(sections.attachments?.items).toEqual([expect.objectContaining({ name: "file.txt" })]);
    expect(sections.comments?.items).toEqual([expect.objectContaining({ body: "사용자 발언" })]);
    expect(sections.notes?.items).toEqual([expect.objectContaining({ body: "최신 작업 기록" })]);
    expect(sections.notes?.truncated).toBe(true);
    expect(sections.notes?.nextCursor).toEqual(expect.any(String));
    expect(sections.reports?.items).toEqual([expect.objectContaining({ body: "보고 전문" })]);

    const olderNotes = await call("get_card", { card_id: "card", include: ["notes"], limit: 1,
      cursors: { notes: sections.notes!.nextCursor! } });
    expect((olderNotes.structuredContent as { sections: { notes: { items: { body: string }[]; truncated: boolean } } }).sections.notes)
      .toMatchObject({ items: [{ body: "이전 작업 기록" }], truncated: false });
  });
  it("uses change tokens to return unchanged or replacement pages", async () => {
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body) VALUES('initial-note','card','agent','note','기존 기록')`;
    const initial = await call("get_card", { card_id: "card" });
    const token = (initial.structuredContent as { changeToken: string }).changeToken;

    const unchanged = await call("get_card", { card_id: "card", since: token });
    expect(unchanged.structuredContent).toMatchObject({ id: "card", unchanged: true, changeToken: token });
    expect(unchanged.structuredContent).not.toHaveProperty("questions");

    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body) VALUES('updated-note','card','agent','note','새 기록')`;
    const changed = await call("get_card", { card_id: "card", since: token, include: ["notes"] });
    expect(changed.structuredContent).toMatchObject({ unchanged: false, changed: expect.arrayContaining(["notes"]),
      sections: { notes: { items: expect.arrayContaining([expect.objectContaining({ body: "새 기록" }),
        expect.objectContaining({ body: "기존 기록" })]), replace: true } } });
  });
  it("pages list_cards by its bounded default and applies folder access before reads", async () => {
    await h.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,assignee_kind,assignee_session_id)
      SELECT 'bulk-'||n::text,'a',lpad(n::text,3,'0'),'카드 '||n::text,'원문','todo','session','owner'
      FROM generate_series(1,20) AS n`;
    access = { restricted: true, allowedFolderIds: ["a"] };

    const first = await call("list_cards", {});
    expect(first.isError).not.toBe(true);
    const page = first.structuredContent as { cards: { id: string }[]; nextCursor: string | null; truncated: boolean };
    expect(page.cards).toHaveLength(20);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.cards.every(card => card.id !== "card-b")).toBe(true);

    const second = await call("list_cards", { cursor: page.nextCursor! });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({ cards: [expect.objectContaining({ id: "card" })], nextCursor: null, truncated: false });

    const all = await call("list_cards", { all: true });
    expect(all.isError).not.toBe(true);
    expect((all.structuredContent as { cards: { id: string }[]; truncated: boolean }).cards).toHaveLength(21);
    expect((all.structuredContent as { cards: { id: string }[] }).cards.some(card => card.id === "card-b")).toBe(false);

    const forbiddenList = await call("list_cards", { folder_id: "b" });
    expect(forbiddenList.isError).toBe(true);
    expect(forbiddenList.content[0]?.text).toContain("Folder access denied");
    const forbiddenRead = await call("get_card", { card_id: "card-b" });
    expect(forbiddenRead.isError).toBe(true);
    expect(forbiddenRead.content[0]?.text).toContain("Folder access denied");
  });
  it("lists exactly the eight external writes while retaining internal work start", () => {
    const writes = ["create_card", "update_card_brief", "add_card_report", "add_card_comment", "set_card_status",
      "request_card_review", "ask_card_question", "move_card"] as const;
    expect(writes.map(name => cardTools[name].audience)).toEqual(writes.map(() => "all"));
    expect(cardTools.start_card_work.audience).toBe("internal");
    for(const name of ["set_card_items","add_card_item","report_card_item","update_card_now","add_card_note","list_card_notes"] as const)
      expect(cardTools[name].audience).toBe("internal");
  });
  it.each([
    ["set_card_items",{items:[{title:"결과"}]}],
    ["add_card_item",{title:"결과",from_comment_id:"comment"}],
    ["report_card_item",{item_id:1,state:"done",result:"완료"}],
    ["update_card_now",{now:"진행 중",turn:"agent"}],
    ["add_card_note",{text:"내부 기록"}],
    ["list_card_notes",{}],
  ] as const)("rejects external access to internal tool %s",async(tool,args)=>{
    const result=await call(tool,{card_id:"card",...args});
    expect(result.isError).toBe(true);
    expect(await h.sql`SELECT id FROM folder_operations`).toHaveLength(0);
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
  it("returns a version that the next real card mutation can use", async () => {
    const brief = await call("update_card_brief", { card_id: "card", brief: "닷 경과" });
    expect(brief.isError).not.toBe(true);
    const returnedVersion = (brief.structuredContent as { card: { version: number } }).card.version;
    expect(returnedVersion).toEqual(expect.any(Number));

    const status = await call("set_card_status", {
      card_id: "card", status: "running", expected_version: returnedVersion, idempotency_key: "brief-then-status",
    });
    expect(status.isError).not.toBe(true);
    expect(await h.sql`SELECT status FROM cards WHERE id='card'`).toEqual([{ status: "running" }]);
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
    expect(result.structuredContent?.guidance).toBe("질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
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
