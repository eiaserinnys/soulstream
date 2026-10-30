import { afterEach, describe, expect, it, vi } from "vitest";
import { liveCardOutputSchema, type CallToolResult, type McpToolName } from "@soulstream/mcp-contract";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { createLiveAtomHttpClient } from "../src/runtime/live_atom_route_provider.js";
import { DEFAULT_DOMAIN_CATALOG_NODE_ID, parseSkillCatalogMarkdown } from "../src/skills/skill_catalog.js";

// Same service-port fixture style as mcp-host-routes.test.ts. These cases replace
// the worker's direct legacy callback tests; SDK/HTTP/PG snapshots live in the worker tests.
const context: McpCallContext = { principal: "internal", callerSessionId: "session-1", nodeId: "node" };
const call = (options: McpHostOptions, name: McpToolName, args: Record<string, unknown>, ctx = context): Promise<CallToolResult> =>
  executeMcpTool(options, name, args, ctx);
afterEach(() => vi.unstubAllGlobals());

function page() {
  return { id: "page-1", title: "Page", daily_date: null, version: 1, archived: false, metadata: {},
    created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
}
function pageHarness() {
  const mutation = { page: page(), blocks: [], temp_id_mapping: {}, operation: { id: "op-1" } };
  const service = {
    getPage: vi.fn().mockResolvedValue({ page: page(), blocks: [] }),
    getBacklinks: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    createPage: vi.fn().mockResolvedValue(mutation), mutatePage: vi.fn().mockResolvedValue(mutation),
    getDailyPage: vi.fn().mockResolvedValue({ page: page(), created: true, operation: { id: "op-1" } }),
  };
  return { service, options: { pages: { service, logger: { error: vi.fn() } } } as unknown as McpHostOptions };
}
describe("page MCP execution", () => {
  it("omits blocks when get_page include_blocks is false", async () => {
    const { service, options } = pageHarness();
    const result = await call(options, "get_page", { page_id: "page-1", include_blocks: false });
    expect(result.structuredContent).toEqual({ page: page() });
    expect(service.getPage).toHaveBeenCalledWith("page-1");
  });
  it("uses explicit caller_session_id for create and preserves operation output", async () => {
    const { service, options } = pageHarness();
    const result = await call(options, "create_page", { title: "Page", id: "page-1",
      idempotency_key: "create_page:session-1:req", caller_session_id: "session-1" });
    expect(result.structuredContent).toMatchObject({ page: { id: "page-1" }, created: true, operation: { id: "op-1" } });
    expect(service.createPage).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ actorSessionId: "session-1" }), idempotencyKey: "create_page:session-1:req",
    }));
  });
  it("falls back to the request header for lazy daily creation", async () => {
    const { service, options } = pageHarness();
    await call(options, "get_daily_page", { date: "2026-07-12" }, { ...context, callerSessionId: "header-session" });
    expect(service.getDailyPage).toHaveBeenCalledWith({ date: "2026-07-12",
      actor: { actorKind: "agent", actorSessionId: "header-session", actorUserId: null } });
  });
  it("rejects invalid XOR and missing CAS before calling the host", async () => {
    const { service, options } = pageHarness();
    const result = await call(options, "batch_page_operations", { page_id: "page-1",
      operations: [{ op: "rename_page", title: "Renamed" }], idempotency_key: "batch:1", caller_session_id: "session-1" });
    expect(result.isError).toBe(true);
    expect(service.mutatePage).not.toHaveBeenCalled();
  });
  it("renders block IDs in markdown and performs explicit full replacement", async () => {
    const { service, options } = pageHarness();
    service.getPage.mockResolvedValueOnce({ page: page(), blocks: [{ id: "root", page_id: "page-1", parent_id: null,
      position_key: "a", block_type: "paragraph", text: "구현", properties: {}, collapsed: false }] })
      .mockResolvedValueOnce({ page: page() });
    const markdown = await call(options, "get_page_markdown", { page_id: "page-1", include_block_ids: true });
    expect(markdown.content[0]?.text).toContain("<!-- block:root -->");
    const replaced = await call(options, "upsert_page_markdown", { page_id: "page-1", expected_version: 1,
      markdown: "# Page\n\n교체", idempotency_key: "replace:1", caller_session_id: "session-1" });
    expect(replaced.structuredContent).toMatchObject({ created: false, operation: { id: "op-1" } });
    expect(service.mutatePage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "page-1", expectedVersion: 1,
      actor: expect.objectContaining({ actorSessionId: "session-1" }),
      command: { type: "replace_page_markdown", blocks: [expect.objectContaining({ text: "교체" })] } }));
  });
  it("excludes self backlinks by default and forwards the explicit opt-in", async () => {
    const { service, options } = pageHarness();
    await call(options, "get_backlinks", { page_id: "page-1" });
    await call(options, "get_backlinks", { page_id: "page-1", include_self: true });
    expect(service.getBacklinks).toHaveBeenNthCalledWith(1, expect.objectContaining({ pageId: "page-1", includeSelf: false }));
    expect(service.getBacklinks).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageId: "page-1", includeSelf: true }));
  });
});

const attachments = [{ nodeId: "node", path: "/incoming/upload/image.png", name: "image.png", mimeType: "image/png" }];
function cardHarness(
  folders: { id: string; parentFolderId?: string | null }[] = [{ id: "folder-1" }, { id: "folder-2" }],
  access = { restricted: false, allowedFolderIds: [] as string[] },
) {
  const card = { id: "card-1", folder_id: "folder-1", title: "카드", status: "running", version: 3, attachments };
  const detail = { card, reports: [{ title: "보고" }], questions: [], comments: [{ body: "지시 요점", kind: "spoken" }], sessions: [],notes:[],nowHistory:[] };
  const readResult = { card: { id: "card-1", number: 1, title: "카드", status: "running", version: 3,
    items: [{ id: 1, title: "저장 결과", state: "done", result: "현재 결과", evidence: [{ type: "link", url: "https://example.test/evidence", label: "근거" }] }] },
    questions: { items: [{ id: "question-1", text: "미답 질문", answer: null }], nextCursor: null, truncated: false },
    available: { request: true, brief: true, attachments: true, comments: 1, notes: 1, reports: 1, sessions: 1, now_history: 0 },
    changeToken: "change-token" };
  const mutation = { snapshot: { folder: { id: "folder-1" }, cards: [card] },
    operation: { id: "op-1", target_kind: "card", target_id: "card-1" } };
  const createdMutation = { ...mutation, snapshot: { ...mutation.snapshot, cards: [{ ...card, status: "todo" }] } };
  const mcpRead = {
    listCards: vi.fn().mockResolvedValue({ cards: [], nextCursor: null, truncated: false }),
    searchCards: vi.fn().mockResolvedValue({ query: "키워드", results: [], truncated: false }),
    getCard: vi.fn().mockResolvedValue(readResult),
  };
  const service = {
    mcpRead, getCard: vi.fn().mockResolvedValue(detail), listCards: vi.fn().mockResolvedValue([card]),
    projectCards: vi.fn(async rows => rows), createCard: vi.fn().mockResolvedValue(createdMutation),
    patchCard: vi.fn().mockResolvedValue(mutation), updateCardBrief: vi.fn().mockResolvedValue(mutation), addReport: vi.fn().mockResolvedValue(mutation),
    addComment: vi.fn().mockResolvedValue({ body: "그대로 보존" }), setCardStatus: vi.fn().mockResolvedValue(mutation),
    startCardWork: vi.fn().mockResolvedValue(mutation),
    requestCardReview:vi.fn().mockResolvedValue(mutation),setCardItems:vi.fn().mockResolvedValue(mutation),
    addCardItem:vi.fn().mockResolvedValue(mutation),reportCardItem:vi.fn().mockResolvedValue(mutation),
    updateCardNow:vi.fn().mockResolvedValue(mutation),addCardNote:vi.fn().mockResolvedValue({id:"note-1",kind:"note"}),
    listCardNotes:vi.fn().mockResolvedValue({notes:[{id:"note-1",kind:"note"}],nextCursor:null}),
    askQuestion: vi.fn().mockResolvedValue(mutation), withdrawQuestion: vi.fn().mockResolvedValue(mutation),
    moveCard: vi.fn().mockResolvedValue(mutation),
  };
  const provider = vi.fn(async () => service);
  const executor = { execute: vi.fn(async () => ({ card: { ...card, status: "running" }, execution: { requestId: "execution-1", sessionId: "spawned-session", state: "pending" } })),
    observe: vi.fn(async () => ({ card: { ...card, status: "running" }, execution: { requestId: "execution-1", sessionId: "spawned-session", state: "started" } })) };
  const cardExecutionServiceProvider = vi.fn(async () => executor);
  const options = { cards: { cardServiceProvider: provider,
    provider: { listFolders: async () => folders },
    cardExecutionServiceProvider, runConfirm: { intervalMs: 1, timeoutMs: 100 },
    resolveAccess: () => access } } as unknown as McpHostOptions;
  return { card, createdMutation, service, mcpRead, provider, executor, cardExecutionServiceProvider, options };
}
describe("card MCP execution", () => {
  it("calls every card service with agent actor, CAS and camelCase input", async () => {
    const h = cardHarness();
    for (const [name, input, method, expected] of [
      ["create_card", { folder_id: "folder-1", title: "제목", request: "원문", attachments, queue: true,
        assignee: { kind: "agent", agent_id: "roselin" }, node_id: "node", model_preset: "sol" }, "createCard",
        { folderId: "folder-1", title: "제목", request: "원문", attachments, queue: true,
          assignee: { kind: "agent", agentId: "roselin" }, nodeId: "node", modelPreset: "sol" }],
      ["list_cards", { folder_id: "folder-1", status: "running" }, "listCards", { folder_id: "folder-1", status: "running" }],
      ["get_card", { card_id: "card-1" }, "getCard", "card-1"],
      ["update_card_brief", { card_id: "card-1", brief: "경과" }, "updateCardBrief", { brief: "경과", expectedVersion: 3 }],
      ["add_card_report", { card_id: "card-1", title: "보고", format: "html", body: "<p>결과</p>" }, "addReport",
        { title: "보고", format: "html", body: "<p>결과</p>" }],
      ["add_card_comment", { card_id: "card-1", text: "회의에서 받은 요청" }, "addComment", { body: "회의에서 받은 요청" }],
      ["set_card_status", { card_id: "card-1", status: "done", expected_version: 3, idempotency_key: "status-write" }, "setCardStatus",
        { status: "done", expectedVersion: 3, idempotencyKey: "status-write" }],
      ["request_card_review", { card_id: "card-1" }, "requestCardReview", {}],
      ["set_card_items",{card_id:"card-1",items:[{title:"화면 결과"}]},"setCardItems",{items:["화면 결과"]}],
      ["add_card_item",{card_id:"card-1",title:"후속 결과",from_comment_id:"comment-1"},"addCardItem",{title:"후속 결과",fromCommentId:"comment-1"}],
      ["report_card_item",{card_id:"card-1",item_id:1,state:"done",result:"완료",evidence:[{type:"link",url:"https://example.test",label:"화면"}]},"reportCardItem",{itemId:1,state:"done",result:"완료",evidence:[{type:"link",url:"https://example.test",label:"화면"}]}],
      ["update_card_now",{card_id:"card-1",now:"결과 반영 중",turn:"agent"},"updateCardNow",{now:"결과 반영 중",turn:"agent"}],
      ["add_card_note",{card_id:"card-1",text:"상세 기록"},"addCardNote",{text:"상세 기록"}],
      ["ask_card_question", { card_id: "card-1", text: "질문", options: ["하나", "둘"] }, "askQuestion", { text: "질문", options: ["하나", "둘"] }],
      ["withdraw_card_question", { card_id: "card-1", question_id: "question-1", reason: "대화에서 결정됨" }, "withdrawQuestion",
        { questionId: "question-1", reason: "대화에서 결정됨" }],
      ["move_card", { card_id: "card-1", folder_id: "folder-2", after_card_id: "card-2" }, "moveCard",
        { folderId: "folder-2", afterCardId: "card-2", expectedVersion: 3 }],
    ] as const) {
      const result = await call(h.options, name, { caller_session_id: "session-1", ...input });
      expect(result.isError, name).not.toBe(true);
      if (name === "list_cards") {
        expect(h.mcpRead.listCards).toHaveBeenLastCalledWith(expected, null);
      } else if (name === "get_card") {
        expect(h.mcpRead.getCard).toHaveBeenLastCalledWith(expected, {}, null);
      } else {
        const spy = h.service[method];
        if (typeof expected === "string") expect(spy).toHaveBeenLastCalledWith(expected);
        else expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ ...expected,
          actorKind: "agent", actorSessionId: "session-1", idempotencyKey: expect.any(String) }));
      }
      if (name === "get_card") {
        expect(JSON.stringify(result)).toContain("현재 결과");
        expect(JSON.stringify(result)).toContain("미답 질문");
        expect(JSON.stringify(result)).not.toContain("지시 요점");
        expect(JSON.stringify(result)).not.toContain("원문");
      }
      if (name === "ask_card_question") expect(JSON.stringify(result)).toContain("질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
    }
  });
  it("rejects a card question unless options are 1~3 short choices", async () => {
    const h = cardHarness();
    for (const options of [undefined, [], ["가", "나", "다", "라"], ["가".repeat(13)], [""]])
      expect((await call(h.options, "ask_card_question", { card_id: "card-1", text: "질문", ...(options === undefined ? {} : { options }) })).isError, JSON.stringify(options)).toBe(true);
    expect(h.service.askQuestion).not.toHaveBeenCalled();
    expect((await call(h.options, "ask_card_question", { card_id: "card-1", text: "질문 1", options: ["진행"] })).isError).not.toBe(true);
    expect((await call(h.options, "ask_card_question", { card_id: "card-1", text: "질문 3", options: ["가".repeat(12), "짧음", "😀"] })).isError).not.toBe(true);
    expect(h.service.askQuestion).toHaveBeenCalledTimes(2);
  });
  it("forwards only R1 read fields and includes allowed descendant folders", async () => {
    const h = cardHarness([{ id: "folder-1" }, { id: "child-1", parentFolderId: "folder-1" }, { id: "folder-2" }],
      { restricted: true, allowedFolderIds: ["folder-1"] });
    await call(h.options, "list_cards", { folder_id: "child-1", status: "running", limit: 7, cursor: "list-cursor", all: false,
      caller_session_id: "untrusted-session" });
    expect(h.mcpRead.listCards).toHaveBeenCalledWith({ folder_id: "child-1", status: "running", limit: 7, cursor: "list-cursor", all: false },
      ["folder-1", "child-1"]);

    await call(h.options, "get_card", { card_id: "card-1", caller_session_id: "untrusted-session",
      include: ["request", "notes"], limit: 4, text_limit: 600, cursors: { notes: "section-cursor" } });
    expect(h.mcpRead.getCard).toHaveBeenCalledWith("card-1", {
      include: ["request", "notes"], limit: 4, text_limit: 600, cursors: { notes: "section-cursor" },
    }, ["folder-1", "child-1"]);
    expect(h.service.getCard).not.toHaveBeenCalled();
  });
  it("routes card search through the read service and forwards list query mode", async () => {
    const h = cardHarness([{ id: "folder-1" }, { id: "child-1", parentFolderId: "folder-1" }, { id: "folder-2" }],
      { restricted: true, allowedFolderIds: ["folder-1"] });
    await call(h.options, "search_cards", { query: "키워드", folder_id: "child-1", status: "running", limit: 7 });
    expect(h.mcpRead.searchCards).toHaveBeenCalledWith({ query: "키워드", folder_id: "child-1", status: "running", limit: 7 },
      ["folder-1", "child-1"]);

    await call(h.options, "list_cards", { query: "키워드", cursor: "ignored", all: true });
    expect(h.mcpRead.listCards).toHaveBeenLastCalledWith({ query: "키워드", cursor: "ignored", all: true },
      ["folder-1", "child-1"]);
  });
  it("returns compact card mutation and item results without echoing saved content", async () => {
    const h = cardHarness();
    const richCard = {
      id: "card-1", number: 12, folder_id: "folder-1", title: "카드", attachments, request: "요청 본문".repeat(40),
      brief: "인계 요약".repeat(1000), status: "running", version: 4,
      items: [
        { id: 1, title: "첫 번째", state: "done", result: "상세 결과".repeat(20),
          evidence: [{ type: "link", url: "https://example.test/first", label: "첫 증거" }],
          caveat: null, rev: 1, confirmed: null, fixOpen: 0, reopened: null },
        { id: 7, title: "일곱 번째", state: "doing", result: "긴 진행 내용".repeat(20),
          evidence: [{ type: "image", url: "https://example.test/seventh", label: "둘째 증거" }],
          caveat: null, rev: 2, confirmed: null, fixOpen: 0, reopened: null },
        { id: 3, title: "세 번째", state: "todo", result: null, evidence: [],
          caveat: null, rev: 0, confirmed: null, fixOpen: 0, reopened: null },
      ],
    };
    const richMutation = {
      snapshot: { folder: { id: "folder-1" }, cards: [richCard] },
      operation: { id: "op-1", target_kind: "card", target_id: "card-1", payload_json: { brief: richCard.brief } },
      idempotent: false,
    } as typeof h.createdMutation;
    expect(richCard.brief.length).toBe(5000);
    const addedMutation = {
      ...richMutation,
      snapshot: { folder: { id: "folder-1" }, cards: [{ ...richCard, items: [...richCard.items,
        { id: 8, title: "여덟 번째", state: "todo", result: null, evidence: [], caveat: null, rev: 0,
          confirmed: null, fixOpen: 0, reopened: null }] }] },
    } as unknown as typeof h.createdMutation;
    const reportedMutation = {
      ...richMutation,
      snapshot: { folder: { id: "folder-1" }, cards: [{ ...richCard, items: richCard.items.map(item =>
        item.id === 3 ? { ...item, state: "done", result: "완료" } : item) }] },
    } as unknown as typeof h.createdMutation;
    h.service.patchCard.mockResolvedValue(richMutation);
    h.service.updateCardBrief.mockResolvedValue(richMutation);
    h.service.addReport.mockResolvedValue(richMutation);
    h.service.setCardStatus.mockResolvedValue(richMutation);
    h.service.startCardWork.mockResolvedValue(richMutation);
    h.service.requestCardReview.mockResolvedValue(richMutation);
    h.service.setCardItems.mockResolvedValue(richMutation);
    h.service.addCardItem.mockResolvedValue(addedMutation);
    h.service.reportCardItem.mockResolvedValue(reportedMutation);
    h.service.updateCardNow.mockResolvedValue(richMutation);
    h.service.askQuestion.mockResolvedValue(richMutation);
    h.service.moveCard.mockResolvedValue({
      ...richMutation, snapshot: { folder: { id: "folder-2" }, cards: [{ ...richCard, folder_id: "folder-2" }] },
    } as typeof h.createdMutation);
    h.service.createCard.mockResolvedValue(richMutation);
    h.service.addCardNote.mockResolvedValue({
      id: "note-1", kind: "note", created_at: "2026-10-05T23:00:00.000Z", text: "노트 본문",
    });
    h.service.addComment.mockResolvedValue({
      id: "comment-1", kind: "comment", author_kind: "user", created_at: "2026-10-05T23:01:00.000Z",
      item_id: 3, body: "커멘트 본문",
    });

    const card = { id: "card-1", number: 12, version: 4, status: "running" };
    const cases = [
      ["update_card_brief", { card_id: "card-1", brief: "짧은 변경" }, { card }],
      ["add_card_report", { card_id: "card-1", title: "보고", format: "markdown", body: "본문" }, { card }],
      ["set_card_status", { card_id: "card-1", status: "done", expected_version: 3, idempotency_key: "status" }, { card }],
      ["transfer_card_assignee", { card_id: "card-1", target_session_id: "session-2", expected_version: 3, idempotency_key: "transfer" }, { card }],
      ["start_card_work", { card_id: "card-1", expected_version: 3, idempotency_key: "start" }, { card }],
      ["request_card_review", { card_id: "card-1", ask: "확인해 주세요" }, { card }],
      ["update_card_now", { card_id: "card-1", now: "진행 중", turn: "agent" }, { card }],
      ["ask_card_question", { card_id: "card-1", text: "질문", options: ["진행"] }, { card, guidance: "질문이 등록되었다. 이 턴을 끝내고 답을 기다린다." }],
      ["move_card", { card_id: "card-1", folder_id: "folder-2" }, { card, folderId: "folder-2" }],
      ["set_card_items", { card_id: "card-1", items: [{ title: "새 항목" }] },
        { card, items: [{ id: 1, title: "첫 번째", state: "done" }, { id: 7, title: "일곱 번째", state: "doing" }, { id: 3, title: "세 번째", state: "todo" }] }],
      ["add_card_item", { card_id: "card-1", title: "새 항목", from_comment_id: "comment-1" },
        { card, item: { id: 8, title: "여덟 번째", state: "todo" } }],
      ["report_card_item", { card_id: "card-1", item_id: 3, state: "done", result: "완료" },
        { card, item: { id: 3, title: "세 번째", state: "done" } }],
    ] as const;

    for (const [name, input, expected] of cases) {
      const result = await call(h.options, name, { caller_session_id: "session-1", ...input },
        name === "start_card_work" ? { ...context, execution: { registrationId: "registration-1", executionCommandId: "command-1" } } : context);
      expect(result.isError, name).not.toBe(true);
      expect(result.structuredContent, name).toEqual(expected);
    }

    const report = await call(h.options, "report_card_item", {
      caller_session_id: "session-1", card_id: "card-1", item_id: 3, state: "done", result: "완료",
    });
    const text = report.content[0]?.text ?? "";
    expect(text.length).toBeLessThan(400);
    expect(JSON.stringify(report)).not.toMatch(/brief|request|operation|payloadJson|folderId|상세 결과|인계 요약/);

    const created = await call(h.options, "create_card", {
      caller_session_id: "session-1", folder_id: "folder-1", title: "새 카드", request: "새 요청",
    });
    expect(created.structuredContent).toEqual({ card });

    const note = await call(h.options, "add_card_note", { caller_session_id: "session-1", card_id: "card-1", text: "노트 본문" });
    expect(note.structuredContent).toEqual({ id: "note-1", createdAt: "2026-10-05T23:00:00.000Z" });
    const comment = await call(h.options, "add_card_comment", {
      caller_session_id: "session-1", card_id: "card-1", text: "커멘트 본문", item_id: 3,
    });
    expect(comment.structuredContent).toEqual({
      id: "comment-1", kind: "comment", authorKind: "user", createdAt: "2026-10-05T23:01:00.000Z", itemId: 3,
    });
    h.service.addComment.mockResolvedValueOnce({
      id: "comment-2", kind: "comment", author_kind: "user", created_at: "2026-10-05T23:02:00.000Z",
      item_id: null, body: "다른 커멘트 본문",
    });
    const commentWithoutItem = await call(h.options, "add_card_comment", {
      caller_session_id: "session-1", card_id: "card-1", text: "다른 커멘트",
    });
    expect(commentWithoutItem.structuredContent).toEqual({
      id: "comment-2", kind: "comment", authorKind: "user", createdAt: "2026-10-05T23:02:00.000Z",
    });
  });
  it("keeps create and execution outputs compact, including replays", async () => {
    const h = cardHarness();
    const cardRow = { id: "card-1", number: 12, folder_id: "folder-1", title: "카드", attachments,
      request: "원문", brief: "인계 요약".repeat(500), status: "running", version: 4 };
    const mutation = {
      snapshot: { folder: { id: "folder-1" }, cards: [cardRow] },
      operation: { id: "op-1", target_kind: "card", target_id: "card-1", payload_json: { request: cardRow.request } },
      idempotent: false,
    } as typeof h.createdMutation;
    h.service.createCard.mockResolvedValue(mutation);
    h.service.getCard.mockResolvedValue({ card: { ...cardRow, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    const executionCard = { ...cardRow, status: "running" };
    h.executor.execute.mockResolvedValueOnce({
      card: executionCard,
      execution: { requestId: "execution-1", sessionId: "spawned-session", state: "started" },
    });

    const createdAndRun = await call(h.options, "create_card", {
      caller_session_id: "session-1", folder_id: "folder-1", title: "새 카드", request: "새 요청", run: true,
    });
    expect(createdAndRun.structuredContent).toEqual({
      card: { id: "card-1", number: 12, version: 4, status: "running" },
      execution: { requestId: "execution-1", sessionId: "spawned-session", state: "started" },
    });

    h.executor.execute.mockResolvedValueOnce({
      card: executionCard,
      execution: { requestId: "execution-1", sessionId: "spawned-session", state: "started" },
    });
    const run = await call(h.options, "run_card", { caller_session_id: "session-1", card_id: "card-1" });
    expect(run.structuredContent).toEqual({
      card: { id: "card-1", number: 12, version: 4, status: "running" },
      execution: { requestId: "execution-1", sessionId: "spawned-session", state: "started" },
    });

    h.options.cards.runConfirm = { intervalMs: 1, timeoutMs: 0 };
    h.executor.execute.mockResolvedValueOnce({
      card: executionCard,
      execution: { requestId: "execution-1", sessionId: "spawned-session", state: "pending" },
    });
    const pendingRun = await call(h.options, "run_card", { caller_session_id: "session-1", card_id: "card-1" });
    expect(pendingRun.structuredContent).toEqual({
      card: { id: "card-1", number: 12, version: 4, status: "running" },
      execution: { requestId: "execution-1", sessionId: "spawned-session", state: "pending" },
      guidance: "실행 시작 확인이 아직이다. 잠시 뒤 같은 카드로 run_card를 다시 부르면 결과를 확인한다.",
    });

    const replay = {
      ...mutation, snapshot: { folder: { id: "folder-1" }, cards: [{ ...cardRow, status: "review" }] }, idempotent: true,
    } as typeof h.createdMutation;
    h.service.createCard.mockResolvedValueOnce(replay);
    const replayed = await call(h.options, "create_card", {
      caller_session_id: "session-1", folder_id: "folder-1", title: "새 카드", request: "새 요청",
      run: true, idempotency_key: "create-replay",
    });
    expect(replayed.structuredContent).toEqual({
      card: { id: "card-1", number: 12, version: 4, status: "review" }, idempotent: true,
    });

    h.service.createCard.mockResolvedValueOnce({
      ...mutation, snapshot: { folder: { id: "folder-1" }, cards: [] }, idempotent: true,
    } as typeof h.createdMutation);
    const replayWithoutCard = await call(h.options, "create_card", {
      caller_session_id: "session-1", folder_id: "folder-1", title: "새 카드", request: "새 요청",
      idempotency_key: "create-replay-without-card",
    });
    expect(replayWithoutCard.structuredContent).toEqual({ card: { id: "card-1" }, idempotent: true });
  });
  it("runs a card through the execution service and waits for registration evidence", async () => {
    const h = cardHarness();
    h.service.getCard.mockResolvedValue({ card: { ...h.card, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    const result = await call(h.options, "run_card", { card_id: "card-1", caller_session_id: "session-1" });
    expect(result.isError).not.toBe(true);
    expect(h.executor.execute).toHaveBeenCalledWith(expect.objectContaining({ actorKind: "agent", actorSessionId: "session-1", cardId: "card-1", expectedVersion: 3 }));
    expect(h.executor.observe).toHaveBeenCalledWith("card-1", "execution-1", expect.objectContaining({ actorKind: "agent", actorSessionId: "session-1" }));
    expect(result.structuredContent).toMatchObject({ execution: { state: "started", sessionId: "spawned-session" }, card: { id: "card-1" } });
  });
  it("runs a card for an external principal as a sessionless LLM actor", async () => {
    const h = cardHarness();
    h.service.getCard.mockResolvedValue({ card: { ...h.card, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    const result = await call(h.options, "run_card", { card_id: "card-1" }, { ...context, principal: "external", callerSessionId: null });
    expect(result.isError).not.toBe(true);
    expect(h.executor.execute).toHaveBeenCalledWith(expect.objectContaining({ actorKind: "llm", actorSessionId: null, cardId: "card-1", expectedVersion: 3 }));
    expect(h.executor.observe).toHaveBeenCalledWith("card-1", "execution-1", expect.objectContaining({ actorKind: "llm", actorSessionId: null }));
    expect(result.structuredContent).toMatchObject({ execution: { state: "started", sessionId: "spawned-session" }, card: { id: "card-1" } });
  });
  it("runs a new card from create_card in the same call and excludes run from the mutation body", async () => {
    const h = cardHarness();
    h.service.getCard.mockResolvedValue({ card: { ...h.card, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문", run: true, caller_session_id: "session-1" });
    expect(result.isError).not.toBe(true);
    expect(h.service.createCard).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-1", title: "제목", actorKind: "agent", actorSessionId: "session-1" }));
    expect(h.service.createCard.mock.calls[0]![0]).not.toHaveProperty("run");
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({ card: { id: "card-1" }, execution: { state: "started" } });
  });
  it("rejects create_card run when caller session differs from the authenticated header", async () => {
    const h = cardHarness();
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문",
      run: true, caller_session_id: "session-B" }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("caller_session_id must match the authenticated request session header");
    expect(h.service.createCard).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
  });
  it("rejects queued create_card when caller session differs from the authenticated header", async () => {
    const h = cardHarness();
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문",
      queue: true, caller_session_id: "session-B" }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("caller_session_id must match the authenticated request session header");
    expect(h.service.createCard).not.toHaveBeenCalled();
  });
  it("uses the serialized operation target when create_card replay has no card snapshot", async () => {
    const h = cardHarness();
    h.service.createCard.mockResolvedValueOnce({ ...h.createdMutation, snapshot: { ...h.createdMutation.snapshot, cards: [] }, idempotent: true });
    h.service.getCard.mockResolvedValue({ card: { ...h.card, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문", run: true,
      idempotency_key: "create-replay", caller_session_id: "session-1" });
    expect(result.isError).not.toBe(true);
    expect(h.executor.execute).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-1" }));
  });
  it("rejects run and queue before creating a card", async () => {
    const h = cardHarness();
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문", run: true, queue: true, caller_session_id: "session-1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ text: "run과 queue는 함께 쓸 수 없습니다" }));
    expect(h.service.createCard).not.toHaveBeenCalled();
  });
  it("includes the created card ID when create_card execution fails", async () => {
    const h = cardHarness();
    h.service.getCard.mockResolvedValue({ card: { ...h.card, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    h.executor.execute.mockRejectedValue(new Error("실행 설정이 없습니다."));
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문", run: true, caller_session_id: "session-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("카드 card-1는 드래프트로 만들어졌지만 실행하지 못했습니다: 실행 설정이 없습니다.");
    expect(result.content[0]?.text).toContain("run_card로 실행하세요.");
  });
  it("creates and executes a card for an external principal as a sessionless LLM actor", async () => {
    const h = cardHarness();
    h.service.getCard.mockResolvedValue({ card: { ...h.card, status: "todo" }, reports: [], questions: [], comments: [], sessions: [], notes: [], nowHistory: [] });
    const result = await call(h.options, "create_card", { folder_id: "folder-1", title: "제목", request: "원문", run: true },
      { ...context, principal: "external", callerSessionId: null });
    expect(result.isError).not.toBe(true);
    expect(h.executor.execute).toHaveBeenCalledWith(expect.objectContaining({ actorKind: "llm", actorSessionId: null, cardId: "card-1" }));
    expect(h.executor.observe).toHaveBeenCalledWith("card-1", "execution-1", expect.objectContaining({ actorKind: "llm", actorSessionId: null }));
    expect(h.service.createCard).toHaveBeenCalledWith(expect.objectContaining({ actorKind: "llm", actorSessionId: null }));
    expect(h.service.createCard.mock.calls[0]![0]).not.toHaveProperty("run");
    expect(result.structuredContent).toMatchObject({ card: { id: "card-1" }, execution: { state: "started" } });
  });
  it("exposes spoken/reply and forwards replies without rewriting their text", async () => {
    const h = cardHarness();
    for (const mode of ["spoken", "reply"] as const) {
      expect((await call(h.options, "add_card_comment", { card_id: "card-1", text: "그대로 보존", mode })).isError).not.toBe(true);
      expect(h.service.addComment).toHaveBeenLastCalledWith(expect.objectContaining({ body: "그대로 보존", mode }));
    }
    expect((await call(h.options, "add_card_comment", { card_id: "card-1", text: "답변", mode: "invalid" })).isError).toBe(true);
    expect(h.service.addComment).toHaveBeenCalledTimes(2);
  });
  it("reads notes through the assigned-session service and returns the cursor envelope",async()=>{
    const h=cardHarness();
    const result=await call(h.options,"list_card_notes",{card_id:"card-1",limit:10,before:"note-cursor",caller_session_id:"session-1"});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({notes:[{id:"note-1",kind:"note"}],nextCursor:null});
    expect(h.service.listCardNotes).toHaveBeenCalledWith(expect.objectContaining({cardId:"card-1",limit:10,before:"note-cursor",actorKind:"agent",actorSessionId:"session-1"}));
  });
  it("rejects the new internal check-item tools for external principals",async()=>{
    const h=cardHarness();
    const result=await call(h.options,"set_card_items",{card_id:"card-1",items:[{title:"결과"}]},{...context,principal:"external",callerSessionId:null});
    expect(result.isError).toBe(true);
    expect(h.service.setCardItems).not.toHaveBeenCalled();
  });
  it.each(["add_card_comment", "set_card_status"] as const)("rejects %s session impersonation before service execution", async name => {
    const h = cardHarness();
    const args = name === "add_card_comment" ? { text: "답변", mode: "reply" }
      : { status: "done", expected_version: 3, idempotency_key: "direct-status" };
    const result = await call(h.options, name, { card_id: "card-1", caller_session_id: "session-1", ...args },
      { ...context, callerSessionId: "authenticated-session" });
    expect(result.isError).toBe(true);
    expect(h.provider).not.toHaveBeenCalled();
  });
  it("returns a server conflict without hiding it", async () => {
    const h = cardHarness();
    h.service.requestCardReview.mockRejectedValue(Object.assign(new Error("낡은 카드 버전"), { statusCode: 409 }));
    const result = await call(h.options, "request_card_review", { card_id: "card-1" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("낡은 카드 버전");
  });
  it("transfers a card through the existing update mutation and keeps the caller as actor", async () => {
    const h = cardHarness();
    const result = await call(h.options, "transfer_card_assignee", {
      card_id: "card-1", target_session_id: "successor-session", expected_version: 3,
      idempotency_key: "handoff-1", reason: "successor takes over", caller_session_id: "session-1",
    });
    expect(result.isError).not.toBe(true);
    expect(h.service.patchCard).toHaveBeenCalledWith(expect.objectContaining({
      cardId: "card-1", assignee: { kind: "session", sessionId: "successor-session" },
      expectedVersion: 3, idempotencyKey: "handoff-1", reason: "successor takes over",
      actorKind: "agent", actorSessionId: "session-1",
    }));
  });
  it("rejects a handoff caller that conflicts with the authenticated session header", async () => {
    const h = cardHarness();
    const result = await call(h.options, "transfer_card_assignee", {
      card_id: "card-1", target_session_id: "successor-session", expected_version: 3,
      idempotency_key: "handoff-1", caller_session_id: "successor-session",
    }, { ...context, callerSessionId: "session-1" });
    expect(result.isError).toBe(true);
    expect(h.provider).not.toHaveBeenCalled();
  });
  it("requires an authenticated internal session header for handoff", async () => {
    const h = cardHarness();
    const result = await call(h.options, "transfer_card_assignee", {
      card_id: "card-1", target_session_id: "successor-session", expected_version: 3,
      idempotency_key: "handoff-1", caller_session_id: "session-1",
    }, { ...context, callerSessionId: null });
    expect(result.isError).toBe(true);
    expect(h.provider).not.toHaveBeenCalled();
  });
});

describe("live card MCP execution", () => {
  it("fetches on open and each refresh, scopes folder and projects fields", async () => {
    const h = cardHarness();
    h.service.listCards.mockImplementation(async () => [{ id: "a", title: "version " + h.service.listCards.mock.calls.length,
      status: "running", request: "private request", latestActivity: { kind: "instruction", format: "markdown", body: "**최신 지시**" } }] as never);
    for (const name of ["show_live_card_view", "list_live_cards"] as const) {
      const result = await call(h.options, name, { folder_id: "folder-1" });
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as any;
      expect(data.cards[0].title).toBe("version " + h.service.listCards.mock.calls.length);
      expect(data.cards[0].request).toBeUndefined();
      expect(data.cards[0].preview).toEqual({ kind: "instruction", text: "최신 지시" });
      expect(data.cards[0].latestActivity).toBeUndefined();
      expect(data.sync).toMatchObject({ folderId: "folder-1", limit: 100 });
      expect(h.service.listCards).toHaveBeenLastCalledWith(expect.objectContaining({ folderId: "folder-1" }));
    }
    expect(h.service.listCards).toHaveBeenCalledTimes(2);
  });
  it("preserves backend denial as an error and never emits an empty-success array", async () => {
    const h = cardHarness();
    h.service.listCards.mockRejectedValue(Object.assign(new Error("private internals"), { statusCode: 403 }));
    const result = await call(h.options, "show_live_card_view", {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ syncError: { authorization: true } });
    expect(JSON.stringify(result)).not.toContain("private internals");
  });
  it("rejects invalid limits before reading; malformed backend result is an error", async () => {
    const h = cardHarness();
    h.service.listCards.mockResolvedValue({ wrong: [] } as never);
    expect((await call(h.options, "list_live_cards", { limit: 101 })).isError).toBe(true);
    expect(h.service.listCards).not.toHaveBeenCalled();
    expect((await call(h.options, "list_live_cards", { limit: 10 })).isError).toBe(true);
    expect(h.service.listCards).toHaveBeenCalledTimes(1);
  });
  it("validates the actual successful result against the advertised output schema", async () => {
    const h = cardHarness(); h.service.listCards.mockResolvedValue([]);
    const result = await call(h.options, "show_live_card_view", {});
    expect(result.isError).not.toBe(true);
    expect(liveCardOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });
});

const SLACK_BODY_NODE_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const atomMarkdown = `## slack-member-recall <!-- node:12111111-1111-4111-8111-111111111111 -->
description: >
  Slack member lookup and recall.
body_node_id: ${SLACK_BODY_NODE_ID}
activity:
  medium: prose
  operations: [plan, retrieve]
  accepts_input: [member_name]
probe_intents: [look up a member from a Slack request]

## work-plan-execute <!-- node:12222222-2222-4222-8222-222222222222 -->
description: >
  Plan and execute coding work.
body_node_id: 77777777-8888-4999-8aaa-bbbbbbbbbbbb

## writing-rhythm <!-- node:12333333-3333-4333-8333-333333333333 -->
description: >
  Write prose with a clear rhythm.
body_node_id: 88888888-9999-4aaa-8bbb-cccccccccccc
`;
const domainCatalogMarkdown = `## tagged-high <!-- node:11111111-1111-4111-8111-111111111111 -->
description: Catalog matching all activity dimensions.
body_node_id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
axis: [prose.member]
composition: orthogonal
applies_to:
  media: [prose]
  operations: [retrieve]
provides_input: [member_name]
sample_cues: [member lookup]

## untagged-mid <!-- node:22222222-2222-4222-8222-222222222222 -->
description: Catalog with no activity tag match.
body_node_id: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
axis: [prose.recall]
composition: orthogonal
applies_to:
  media: [still]
  operations: [edit]
provides_input: [image_refs]

## tagged-low <!-- node:33333333-3333-4333-8333-333333333333 -->
description: Lower Jev score with activity tag matches.
body_node_id: cccccccc-cccc-4ccc-8ccc-cccccccccccc
axis: [prose.notes]
composition: orthogonal
applies_to:
  media: [prose]
  operations: [plan]
provides_input: [member_name]

## tagged-weak <!-- node:55555555-5555-4555-8555-555555555555 -->
description: Weak Jev score with activity tag matches.
body_node_id: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee
axis: [prose.weak]
composition: orthogonal
applies_to:
  media: [prose]
  operations: [plan]
provides_input: [member_name]

## tagged-zero <!-- node:44444444-4444-4444-8444-444444444444 -->
description: Tag match with zero Jev score.
body_node_id: dddddddd-dddd-4ddd-8ddd-dddddddddddd
axis: [prose.zero]
composition: orthogonal
applies_to:
  media: [prose]
  operations: [plan]
provides_input: [member_name]
`;

const bindingCatalogMarkdown = `## seosoyoung-canon <!-- node:55555555-5555-4555-8555-555555555555 -->
description: Seosoyoung character reference catalog.
body_node_id: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee
axis: [subject.identity]
composition: bundle
bindings:
  - target_catalog: character-acting
    target_axis: subject.expression
    sheet_template: references/facs/{style}-facs-12.png
    grid: 4x3
  - target_catalog: lighting-setup
    target_axis: light.setup
    sheet_template: references/lighting/{style}-lighting-12.png
    grid: 4x3

## character-acting <!-- node:66666666-6666-4666-8666-666666666666 -->
description: Generic character acting catalog.
body_node_id: ffffffff-ffff-4fff-8fff-ffffffffffff
axis: [subject.expression, subject.head-angle]
composition: orthogonal
aliases: [acting-cues]
applies_to:
  media: [still, video]
  operations: [plan, generate, edit]
provides_input: [prompt_cues]
sample_cues: [AU0 Neutral]
shards:
  - name: expression-cues
    node_id: 99999999-aaaa-4bbb-8ccc-dddddddddddd
    sample_node_id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
    cues: [AU0 Neutral]

## psychedelic-maid-canon <!-- node:77777777-7777-4777-8777-777777777777 -->
description: Another character identity bundle.
body_node_id: 88888888-8888-4888-8888-888888888888
axis: [subject.identity]
composition: bundle
`;

function skillsHarness(
  nodeId: string,
  apiKey = "typesafe-test-key",
  catalogsNodeId = DEFAULT_DOMAIN_CATALOG_NODE_ID,
  scoreByName: Record<string, number> = {},
  domainMarkdown = domainCatalogMarkdown,
  skillMarkdown = atomMarkdown,
) {
  const logger = { warn: vi.fn() };
  const knownNodeIds = new Set<string>();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith(`/tree/${catalogsNodeId}/compile`)) {
      return Response.json({ markdown: domainMarkdown });
    }
    if (url.pathname.endsWith(`/tree/${nodeId}/compile`)) return Response.json({ markdown: skillMarkdown });
    if (url.pathname === "/mcp") {
      const request = JSON.parse(String(init?.body));
      const requestedNodeId = request.params.arguments.node_id as string;
      knownNodeIds.add(requestedNodeId);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: JSON.stringify({ id: requestedNodeId, parent_node_id: null, card: { version: 4 } }) }] },
      });
    }
    const nodeMatch = /^\/tree\/([^/]+)$/.exec(url.pathname);
    if (nodeMatch) {
      const requestedNodeId = decodeURIComponent(nodeMatch[1]!);
      knownNodeIds.add(requestedNodeId);
      return Response.json({ id: requestedNodeId, parent_node_id: null, card: { version: 4 } });
    }
    if (url.pathname === "/api/tree/outline") {
      return Response.json({ nodes: [...knownNodeIds].map(id => ({ id, child_count: 0 })) });
    }
    const bodyCompileMatch = /^\/api\/tree\/([^/]+)\/compile$/.exec(url.pathname);
    if (bodyCompileMatch) {
      const bodyNodeId = decodeURIComponent(bodyCompileMatch[1]!);
      return Response.json({ markdown: `# Loaded body <!-- node:${bodyNodeId} card:88888888-8888-4888-8888-888888888888 -->\n\nBody for ${bodyNodeId}` });
    }
    if (url.toString() === "https://api.typesafe.ai/v1/systemone") {
      const body = JSON.parse(String(init?.body));
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key =>
        [key, { type: "score", score: scoreByName[key] ?? (key === "slack-member-recall" ? 3 : 2) }])) });
    }
    throw new Error("Unexpected fetch URL");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, logger, options: { skills: { enabled: true, serverUrl: "https://atom.example.test", apiKey: "atom-test-key",
    nodeId, catalogsNodeId, typesafeApiKey: apiKey, logger, httpClient: createLiveAtomHttpClient({ fetch: fetchMock }) } } as unknown as McpHostOptions };
}
describe("search_skills MCP execution", () => {
  it("returns an exact name match without calling Typesafe", async () => {
    const h = skillsHarness("11111111-2222-4333-8444-555555555555");
    const result = await call(h.options, "search_skills", { query: " Slack-Member-Recall " });
    expect(result.structuredContent).toEqual({ mode: "exact", query: " Slack-Member-Recall ", matches: [{
      name: "slack-member-recall", description: "Slack member lookup and recall.\n", body_node_id: SLACK_BODY_NODE_ID, score: 1 }] });
    expect(h.fetchMock.mock.calls.filter(([input]) => input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(0);
  });
  it("preserves the truncation error when the skill catalog is truncated", async () => {
    const h = skillsHarness(
      "99999999-2222-4333-8444-555555555555",
      "typesafe-test-key",
      DEFAULT_DOMAIN_CATALOG_NODE_ID,
      {},
      domainCatalogMarkdown,
      `${atomMarkdown}\n<!-- truncated: 200 chars omitted -->`,
    );

    const result = await call(h.options, "search_skills", { query: "slack-member-recall" });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "Skill catalog response was truncated" });
  });
  it("ranks candidates and respects the requested limit", async () => {
    const h = skillsHarness("99999999-aaaa-4bbb-8ccc-dddddddddddd");
    const result = await call(h.options, "search_skills", { query: "help with a Slack member request", limit: 2 });
    expect(result.structuredContent).toMatchObject({ mode: "ranked", query: "help with a Slack member request",
      matches: [{ name: "slack-member-recall", score: 1 }, { name: "work-plan-execute", score: 2 / 3 }] });
    expect((result.structuredContent as any).matches).toHaveLength(2);
    expect(h.fetchMock.mock.calls.filter(([input]) => input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });
  it("returns the configured error when Typesafe key is missing", async () => {
    const h = skillsHarness("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "");
    const result = await call(h.options, "search_skills", { query: "help with an unrelated request" });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "TYPESAFE_API_KEY is not configured" });
    expect(h.fetchMock.mock.calls.filter(([input]) => input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(0);
  });
});

describe("load_skill MCP execution", () => {
  it("reads the selected skill body without reading the domain catalog or calling Jev when it has no pick", async () => {
    const h = skillsHarness("11111111-2222-4333-8444-555555555555");
    const result = await call(h.options, "load_skill", { name: "slack-member-recall" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      name: "slack-member-recall",
      entry_version: 4,
      body_version: 4,
      compiled_markdown: expect.stringContaining("Body for 66666666-7777-4888-8999-aaaaaaaaaaaa"),
      links: [],
      active_bindings: [],
      pins: [],
    });
    expect(h.fetchMock.mock.calls.some(([input]) => new URL(input.toString()).pathname.endsWith(`/tree/${DEFAULT_DOMAIN_CATALOG_NODE_ID}/compile`))).toBe(false);
    expect(h.fetchMock.mock.calls.filter(([input]) => input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(0);
    const bodyCompile = h.fetchMock.mock.calls.find(([input]) => new URL(input.toString()).pathname.endsWith(`/tree/${SLACK_BODY_NODE_ID}/compile`));
    expect(new URL(bodyCompile![0].toString()).searchParams.get("depth")).toBe("0");
  });

  it("preserves the truncation error when load_skill cannot read the skill catalog", async () => {
    const h = skillsHarness(
      "99999999-3333-4333-8444-555555555555",
      "typesafe-test-key",
      DEFAULT_DOMAIN_CATALOG_NODE_ID,
      {},
      domainCatalogMarkdown,
      `${atomMarkdown}\n<!-- truncated: 200 chars omitted -->`,
    );

    const result = await call(h.options, "load_skill", { name: "slack-member-recall" });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "Skill catalog response was truncated" });
  });
});

describe("match_skill_catalogs MCP execution", () => {
  it("adds activity tag boosts without excluding catalogs from Jev evaluation", async () => {
    expect(parseSkillCatalogMarkdown(atomMarkdown, { warn: vi.fn() })[0]).toMatchObject({
      activity: { medium: "prose", operations: ["plan", "retrieve"], acceptsInput: ["member_name"] },
      probeIntents: ["look up a member from a Slack request"],
    });

    const catalogsNodeId = "99999999-9999-4999-8999-999999999999";
    const h = skillsHarness("aaaaaaaa-1111-4111-8111-111111111111", "typesafe-test-key", catalogsNodeId, {
      "tagged-high": 2,
      "untagged-mid": 2,
      "tagged-low": 1,
      "tagged-weak": 0.6,
      "tagged-zero": 0,
    });

    const result = await call(h.options, "match_skill_catalogs", {
      intent: "Find the right skills for looking up a Slack member",
      skill_name: "slack-member-recall",
      limit: 4,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      matches: [
        { name: "tagged-high", jev_score: 2 / 3, tag_boost: 0.25, matched_dimensions: ["medium", "operations", "input"], score: 0.9167 },
        { name: "untagged-mid", jev_score: 2 / 3, tag_boost: 0, matched_dimensions: [], score: 0.6667 },
        { name: "tagged-low", jev_score: 1 / 3, tag_boost: 0.25, matched_dimensions: ["medium", "operations", "input"], score: 0.5833 },
      ],
      active_bindings: [],
    });
    expect((result.structuredContent as any).matches).toHaveLength(3);

    const jevRequest = h.fetchMock.mock.calls.find(([input]) => input.toString() === "https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(jevRequest?.[1]?.body)).state.candidates.map((item: { key: string }) => item.key)).toEqual([
      "tagged-high", "untagged-mid", "tagged-low", "tagged-weak", "tagged-zero",
    ]);
    expect(JSON.parse(String(jevRequest?.[1]?.body)).state).toMatchObject({
      skill_name: "slack-member-recall",
      skill_description: "Slack member lookup and recall.\n",
    });
    expect((result.structuredContent as any).matches.map((match: { name: string }) => match.name)).not.toContain("tagged-weak");
  });

  it("returns the truncation error when the fetched domain catalog markdown is truncated", async () => {
    const catalogsNodeId = "99999999-7777-4777-8777-999999999999";
    const h = skillsHarness(
      "77777777-6666-4666-8666-777777777777",
      "typesafe-test-key",
      catalogsNodeId,
      {},
      `${domainCatalogMarkdown}\n<!-- truncated: 200 chars omitted -->`,
    );

    const result = await call(h.options, "match_skill_catalogs", {
      intent: "Choose a prose skill catalog",
      skill_name: "unknown-skill",
      limit: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "Domain catalog response was truncated" });
  });

  it("keeps one bundle per shared axis and activates bindings for selected targets", async () => {
    const catalogsNodeId = "99999999-8888-4888-8888-999999999999";
    const h = skillsHarness(
      "bbbbbbbb-1111-4111-8111-111111111111",
      "typesafe-test-key",
      catalogsNodeId,
      { "seosoyoung-canon": 3, "character-acting": 3, "psychedelic-maid-canon": 2 },
      bindingCatalogMarkdown,
    );

    const result = await call(h.options, "match_skill_catalogs", {
      intent: "Create an expressive portrait of Seosoyoung",
      skill_name: "unknown-skill",
      limit: 5,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      matches: [
        { name: "seosoyoung-canon", composition: "bundle", axis: ["subject.identity"] },
        {
          name: "character-acting",
          composition: "orthogonal",
          axis: ["subject.expression", "subject.head-angle"],
          aliases: ["acting-cues"],
          applies_to: { media: ["still", "video"], operations: ["plan", "generate", "edit"] },
          provides_input: ["prompt_cues"],
          sample_cues: ["AU0 Neutral"],
          shards: [{
            name: "expression-cues",
            node_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
            sample_node_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            cues: ["AU0 Neutral"],
          }],
        },
      ],
      active_bindings: [{
        source_catalog: "seosoyoung-canon",
        target_catalog: "character-acting",
        target_axis: "subject.expression",
        sheet_template: "references/facs/{style}-facs-12.png",
        grid: "4x3",
      }],
    });
    expect((result.structuredContent as any).matches.map((match: { name: string }) => match.name)).not.toContain("psychedelic-maid-canon");
  });
});
