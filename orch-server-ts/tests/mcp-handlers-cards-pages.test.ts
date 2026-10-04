import { afterEach, describe, expect, it, vi } from "vitest";
import { liveCardOutputSchema, type CallToolResult, type McpToolName } from "@soulstream/mcp-contract";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpCallContext, McpHostOptions } from "../src/mcp/types.js";
import { createLiveAtomHttpClient } from "../src/runtime/live_atom_route_provider.js";

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
function cardHarness() {
  const card = { id: "card-1", folder_id: "folder-1", title: "카드", status: "running", version: 3, attachments };
  const detail = { card, reports: [{ title: "보고" }], questions: [], comments: [{ body: "지시 요점", kind: "spoken" }], sessions: [] };
  const mutation = { snapshot: { folder: { id: "folder-1" }, cards: [card] },
    operation: { id: "op-1", target_kind: "card", target_id: "card-1" } };
  const service = {
    getCard: vi.fn().mockResolvedValue(detail), listCards: vi.fn().mockResolvedValue([card]),
    projectCards: vi.fn(async rows => rows), createCard: vi.fn().mockResolvedValue(mutation),
    patchCard: vi.fn().mockResolvedValue(mutation), addReport: vi.fn().mockResolvedValue(mutation),
    addComment: vi.fn().mockResolvedValue({ body: "그대로 보존" }), setCardStatus: vi.fn().mockResolvedValue(mutation),
    askQuestion: vi.fn().mockResolvedValue(mutation), moveCard: vi.fn().mockResolvedValue(mutation),
  };
  const provider = vi.fn(async () => service);
  const options = { cards: { cardServiceProvider: provider,
    provider: { listFolders: async () => [{ id: "folder-1" }, { id: "folder-2" }] },
    resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) } } as unknown as McpHostOptions;
  return { service, provider, options };
}
describe("card MCP execution", () => {
  it("calls every card service with agent actor, CAS and camelCase input", async () => {
    const h = cardHarness();
    for (const [name, input, method, expected] of [
      ["create_card", { folder_id: "folder-1", title: "제목", request: "원문", attachments, queue: true,
        assignee: { kind: "agent", agent_id: "roselin" }, node_id: "node", model_preset: "sol" }, "createCard",
        { folderId: "folder-1", title: "제목", request: "원문", attachments, queue: true,
          assignee: { kind: "agent", agentId: "roselin" }, nodeId: "node", modelPreset: "sol" }],
      ["list_cards", { folder_id: "folder-1", status: "running" }, "listCards", { folderId: "folder-1", status: "running" }],
      ["get_card", { card_id: "card-1" }, "getCard", "card-1"],
      ["update_card_brief", { card_id: "card-1", brief: "경과" }, "patchCard", { brief: "경과", expectedVersion: 3 }],
      ["add_card_report", { card_id: "card-1", title: "보고", format: "html", body: "<p>결과</p>" }, "addReport",
        { title: "보고", format: "html", body: "<p>결과</p>" }],
      ["add_card_comment", { card_id: "card-1", text: "회의에서 받은 요청" }, "addComment", { body: "회의에서 받은 요청", mode: "spoken" }],
      ["set_card_status", { card_id: "card-1", status: "done", expected_version: 3, idempotency_key: "status-write" }, "setCardStatus",
        { status: "done", expectedVersion: 3, idempotencyKey: "status-write" }],
      ["request_card_review", { card_id: "card-1" }, "setCardStatus", { status: "review", expectedVersion: 3 }],
      ["ask_card_question", { card_id: "card-1", text: "질문", options: ["하나", "둘"] }, "askQuestion", { text: "질문", options: ["하나", "둘"] }],
      ["move_card", { card_id: "card-1", folder_id: "folder-2", after_card_id: "card-2" }, "moveCard",
        { folderId: "folder-2", afterCardId: "card-2", expectedVersion: 3 }],
    ] as const) {
      const result = await call(h.options, name, { caller_session_id: "session-1", ...input });
      expect(result.isError, name).not.toBe(true);
      const spy = h.service[method];
      if (typeof expected === "string") expect(spy).toHaveBeenLastCalledWith(expected);
      else expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ ...expected,
        ...(name === "list_cards" ? {} : { actorKind: "agent", actorSessionId: "session-1", idempotencyKey: expect.any(String) }) }));
      if (name === "get_card") {
        expect(JSON.stringify(result)).toContain("지시 요점");
        expect(JSON.stringify(result)).toContain(JSON.stringify(attachments));
      }
      if (name === "ask_card_question") expect(JSON.stringify(result)).toContain("질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
    }
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
    h.service.setCardStatus.mockRejectedValue(Object.assign(new Error("낡은 카드 버전"), { statusCode: 409 }));
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
const atomMarkdown = `## slack-member-recall
description: >
  Slack member lookup and recall.
body_node_id: ${SLACK_BODY_NODE_ID}

## work-plan-execute
description: >
  Plan and execute coding work.
body_node_id: 77777777-8888-4999-8aaa-bbbbbbbbbbbb

## writing-rhythm
description: >
  Write prose with a clear rhythm.
body_node_id: 88888888-9999-4aaa-8bbb-cccccccccccc
`;
function skillsHarness(nodeId: string, apiKey = "typesafe-test-key") {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/compile")) return Response.json({ markdown: atomMarkdown });
    if (url.toString() === "https://api.typesafe.ai/v1/systemone") {
      const body = JSON.parse(String(init?.body));
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(key =>
        [key, { type: "score", score: key === "slack-member-recall" ? 3 : 2 }])) });
    }
    throw new Error("Unexpected fetch URL");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, options: { skills: { enabled: true, serverUrl: "https://atom.example.test", apiKey: "atom-test-key",
    nodeId, typesafeApiKey: apiKey, logger: { warn: vi.fn() }, httpClient: createLiveAtomHttpClient({ fetch: fetchMock }) } } as unknown as McpHostOptions };
}
describe("search_skills MCP execution", () => {
  it("returns an exact name match without calling Typesafe", async () => {
    const h = skillsHarness("11111111-2222-4333-8444-555555555555");
    const result = await call(h.options, "search_skills", { query: " Slack-Member-Recall " });
    expect(result.structuredContent).toEqual({ mode: "exact", query: " Slack-Member-Recall ", matches: [{
      name: "slack-member-recall", description: "Slack member lookup and recall.\n", body_node_id: SLACK_BODY_NODE_ID, score: 1 }] });
    expect(h.fetchMock.mock.calls.filter(([input]) => input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(0);
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
