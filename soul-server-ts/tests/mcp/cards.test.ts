import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerFolderTools } from "../../src/mcp/tools/folder.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { FolderService } from "../../src/folder/folder_service.js";
import { resolvePrimarySessionFolderContext } from "../../src/context/session_folder_context.js";
import { buildSoulstreamContextItem } from "../../src/context/soulstream_item.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { makeTaskCreationHarness } from "../task/task_creation_harness.js";

// Reuses folder.test.ts tool registration and task_creation.test.ts creation harness;
// direct callbacks isolate the new card wire contract without opening an MCP server.
const names = ["create_card", "list_cards", "get_card", "update_card_brief", "add_card_report",
  "request_card_review", "ask_card_question", "move_card"];
const logger = pino({ level: "silent" });
const card = { id: "card-1", folderId: "folder-1", title: "카드", status: "running", version: 3 };
const detail = { card, reports: [{ title: "보고" }], questions: [], sessions: [] };
function harness() {
  const entries = new Map<string, { config: { inputSchema: z.ZodRawShape }; callback: (input: unknown) => Promise<any> }>();
  const service = new FolderService({ orch: { baseUrl: "https://orch.test", headers: { authorization: "Bearer test-service" } }, logger });
  registerFolderTools({ registerTool: (name: string, config: any, callback: any) => entries.set(name, { config, callback }) } as unknown as McpServer,
    { folderService: service } as McpRuntime);
  return { entries, call: async (name: string, input: object) => {
    const entry = entries.get(name)!;
    return entry.callback(z.object(entry.config.inputSchema).parse({ caller_session_id: "session-1", ...input }));
  } };
}
afterEach(() => vi.unstubAllGlobals());
describe("card MCP contract", () => {
  it("registers eight card tools and removes every checklist item/section tool", () => {
    const { entries } = harness();
    expect([...entries.keys()]).toEqual(expect.arrayContaining(names));
    expect([...entries.keys()].filter(n => /checklist_(item|section)|set_card_status|list_my_turn_items/.test(n))).toEqual([]);
    expect(entries.has("set_folder_checklist_enabled")).toBe(true);
  });
  it("calls every card HTTP with the service bearer, agent actor, CAS and camelCase body", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "GET" ? detail : { card }), { status: init.method === "GET" ? 200 : 201 }));
    vi.stubGlobal("fetch", fetch);
    const h = harness();
    for (const [name, input, method, path, body] of [
      ["create_card", { folder_id: "folder-1", title: "제목", request: "원문", queue: true, assignee: { kind: "agent", agent_id: "roselin" }, node_id: "node", model_preset: "sol" }, "POST", "/api/cards", { folderId: "folder-1", title: "제목", request: "원문", queue: true, assignee: { kind: "agent", agentId: "roselin" }, nodeId: "node", modelPreset: "sol" }],
      ["list_cards", { folder_id: "folder-1", status: "running" }, "GET", "/api/cards?folderId=folder-1&status=running", undefined],
      ["get_card", { card_id: "card-1" }, "GET", "/api/cards/card-1", undefined],
      ["update_card_brief", { card_id: "card-1", brief: "경과" }, "PATCH", "/api/cards/card-1", { brief: "경과", expectedVersion: 3 }],
      ["add_card_report", { card_id: "card-1", title: "보고", format: "html", body: "<p>결과</p>" }, "POST", "/api/cards/card-1/reports", { title: "보고", format: "html", body: "<p>결과</p>" }],
      ["request_card_review", { card_id: "card-1" }, "POST", "/api/cards/card-1/status", { status: "review", expectedVersion: 3 }],
      ["ask_card_question", { card_id: "card-1", text: "질문", options: ["하나", "둘"] }, "POST", "/api/cards/card-1/questions", { text: "질문", options: ["하나", "둘"] }],
      ["move_card", { card_id: "card-1", folder_id: "folder-2", after_card_id: "card-2" }, "POST", "/api/cards/card-1/move", { folderId: "folder-2", afterCardId: "card-2", expectedVersion: 3 }],
    ] as const) {
      const result = await h.call(name, input);
      expect(result.isError, name).not.toBe(true);
      const [url, init] = fetch.mock.calls.at(-1)!;
      expect(url).toBe(`https://orch.test${path}`);
      expect(init.method).toBe(method);
      expect(init.headers).toMatchObject({ authorization: "Bearer test-service", "x-soulstream-agent-session-id": "session-1" });
      if (body) expect(JSON.parse(init.body as string)).toMatchObject({ ...body, idempotencyKey: expect.any(String) });
      if (name === "ask_card_question") expect(JSON.stringify(result)).toContain("질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
    }
  });
  it("returns the orch rejection when review has no report", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "GET"
      ? new Response(JSON.stringify(detail))
      : new Response(JSON.stringify({ detail: { error: { message: "보고 없이 검수 요청 불가" } } }), { status: 422 })));
    const result = await harness().call("request_card_review", { card_id: "card-1" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("보고 없이 검수 요청 불가");
  });
  it("injects the same card context for agent and browser sessions using sessions.card_id", async () => {
    for (const source of ["agent", "browser"]) {
    const db = { getSession: vi.fn().mockResolvedValue({ folder_id: "folder-1", card_id: "card-1" }),
      getFolderById: vi.fn().mockResolvedValue({ id: "folder-1", name: "폴더", checklist_enabled: false }),
      getFolderSnapshot: vi.fn().mockResolvedValue({ cards: [card] }),
      getPrimarySessionBoardItem: vi.fn() };
    const context = await resolvePrimarySessionFolderContext(db as unknown as SessionDB, logger, "session-1", "folder-1");
    const item = buildSoulstreamContextItem({ agentSessionId: "session-1", workspaceDir: "/workspace", callerInfo: { source }, ...context } as any);
    const content = item.content as Record<string, unknown>;
    expect({ card: content.card, card_guidance: content.card_guidance }).toMatchInlineSnapshot(`
      {
        "card": {
          "id": "card-1",
          "status": "running",
          "title": "카드",
        },
        "card_guidance": "이 세션은 카드 card-1를 맡았다. 경과는 update_card_brief, 보고는 add_card_report, 검수는 request_card_review, 질문은 ask_card_question으로 남긴다. AskUserQuestion은 쓰지 않는다.",
      }
    `);
    expect(content.folder_guidance).toContain("카드");
    expect(content).not.toHaveProperty("source_checklist_item_id");
    expect(db.getPrimarySessionBoardItem).not.toHaveBeenCalled();
    }
  });
  it("passes cardId at session registration and keeps it out of board projection", async () => {
    const h = makeTaskCreationHarness();
    await h.creation.createTask({ agentSessionId: "session-1", prompt: "작업", folderId: "folder-1", cardId: "card-1" } as any);
    await h.creation.waitForDeferredEffects("session-1");
    expect(h.registerSession.mock.calls[0][0]).toMatchObject({ cardId: "card-1" });
    expect(h.upsertSessionBoardItem.mock.calls[0][0]).not.toHaveProperty("cardId");
  });
});
