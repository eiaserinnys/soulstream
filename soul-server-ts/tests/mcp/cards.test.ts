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
import { withMcpRequestContext } from "../../src/mcp/request_context.js";

// Reuses folder.test.ts tool registration and task_creation.test.ts creation harness;
// direct callbacks isolate the new card wire contract without opening an MCP server.
const names = ["create_card", "list_cards", "get_card", "update_card_brief", "add_card_report", "add_card_comment",
  "request_card_review", "ask_card_question", "move_card", "start_card_work", "set_card_status"];
const logger = pino({ level: "silent" });
const attachments=[{nodeId:"node",path:"/incoming/upload/image.png",name:"image.png",mimeType:"image/png"}];
const card = { id: "card-1", folderId: "folder-1", title: "카드", status: "running", version: 3, attachments };
const detail = { card, reports: [{ title: "보고" }], questions: [], comments: [{ body: "지시 요점", kind: "spoken" }], sessions: [] };
function harness(task?:Record<string,unknown>) {
  const entries = new Map<string, { config: { inputSchema: z.ZodRawShape }; callback: (input: unknown) => Promise<any> }>();
  const service = new FolderService({ orch: { baseUrl: "https://orch.test", headers: { authorization: "Bearer test-service" } }, logger });
  registerFolderTools({ registerTool: (name: string, config: any, callback: any) => entries.set(name, { config, callback }) } as unknown as McpServer,
    { folderService: service,taskManager:{getTask:()=>task} } as unknown as McpRuntime);
  return { entries, call: async (name: string, input: object) => {
    const entry = entries.get(name)!;
    return entry.callback(z.object(entry.config.inputSchema).parse({ caller_session_id: "session-1", ...input }));
  } };
}
afterEach(() => vi.unstubAllGlobals());
describe("card MCP contract", () => {
  it("registers explicit card work alongside existing card tools and removes every checklist item/section tool", () => {
    const { entries } = harness();
    expect([...entries.keys()]).toEqual(expect.arrayContaining(names));
    expect([...entries.keys()].filter(n => /checklist_(item|section)|list_my_turn_items/.test(n))).toEqual([]);
    expect(entries.has("set_folder_checklist_enabled")).toBe(false);
  });
  it("calls every card HTTP with the service bearer, agent actor, CAS and camelCase body", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "GET" ? detail : { card }), { status: init.method === "GET" ? 200 : 201 }));
    vi.stubGlobal("fetch", fetch);
    const h = harness();
    for (const [name, input, method, path, body] of [
      ["create_card", { folder_id: "folder-1", title: "제목", request: "원문", attachments, queue: true, assignee: { kind: "agent", agent_id: "roselin" }, node_id: "node", model_preset: "sol" }, "POST", "/api/cards", { folderId: "folder-1", title: "제목", request: "원문", attachments, queue: true, assignee: { kind: "agent", agentId: "roselin" }, nodeId: "node", modelPreset: "sol" }],
      ["list_cards", { folder_id: "folder-1", status: "running" }, "GET", "/api/cards?folderId=folder-1&status=running", undefined],
      ["get_card", { card_id: "card-1" }, "GET", "/api/cards/card-1", undefined],
      ["update_card_brief", { card_id: "card-1", brief: "경과" }, "PATCH", "/api/cards/card-1", { brief: "경과", expectedVersion: 3 }],
      ["add_card_report", { card_id: "card-1", title: "보고", format: "html", body: "<p>결과</p>" }, "POST", "/api/cards/card-1/reports", { title: "보고", format: "html", body: "<p>결과</p>" }],
      ["add_card_comment", { card_id: "card-1", text: "회의에서 받은 요청" }, "POST", "/api/cards/card-1/comments", { body: "회의에서 받은 요청", mode: "spoken" }],
      ["set_card_status", { card_id: "card-1", status: "done", expected_version: 3, idempotency_key: "status-write" }, "POST", "/api/cards/card-1/status", { status: "done", expectedVersion: 3, idempotencyKey: "status-write" }],
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
      if (name === "add_card_comment") expect(h.entries.get(name)!.config.description).toContain("아래는 사용자의 발언을 요약하여 옮긴 것입니다");
      if (name === "get_card") {expect(JSON.stringify(result)).toContain("지시 요점");expect(JSON.stringify(result)).toContain(JSON.stringify(attachments));}
      if (name === "ask_card_question") expect(JSON.stringify(result)).toContain("질문이 등록되었다. 이 턴을 끝내고 답을 기다린다.");
    }
  });
  it("exposes spoken/reply and forwards replies without rewriting their text", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ card }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const h = harness();
    const schema = z.object(h.entries.get("add_card_comment")!.config.inputSchema);
    expect(schema.parse({ card_id: "card-1", text: "답변", mode: "reply" }).mode).toBe("reply");
    expect(schema.safeParse({ card_id: "card-1", text: "답변", mode: "invalid" }).success).toBe(false);
    for (const mode of ["spoken", "reply"] as const) {
      expect((await h.call("add_card_comment", { card_id: "card-1", text: "그대로 보존", mode })).isError).not.toBe(true);
      expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body))).toMatchObject({ body: "그대로 보존", mode });
    }
  });
  it("rejects reply session impersonation and external callers before HTTP", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const h = harness();
    for (const context of [
      { callerSessionId: "authenticated-session" },
      { principal: { authority: "external" as const, source: "llm", displayName: "External LLM" } },
    ]) {
      const result = await withMcpRequestContext(context, () => h.call("add_card_comment", { card_id: "card-1", text: "답변", mode: "reply" }));
      expect(result.isError).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects status actor impersonation and external callers before HTTP", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const h = harness();
    for (const context of [
      { callerSessionId: "authenticated-session" },
      { principal: { authority: "external" as const, source: "llm", displayName: "External LLM" } },
    ]) {
      const result = await withMcpRequestContext(context, () => h.call("set_card_status", {
        card_id: "card-1", status: "done", expected_version: 3, idempotency_key: "direct-status",
      }));
      expect(result.isError).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns a server conflict without hiding it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => init.method === "GET"
      ? new Response(JSON.stringify(detail))
      : new Response(JSON.stringify({ detail: { error: { message: "낡은 카드 버전" } } }), { status: 409 })));
    const result = await harness().call("request_card_review", { card_id: "card-1" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("낡은 카드 버전");
  });
  it("derives work execution only from runtime and preserves supplied CAS/idempotency", async () => {
    const fetch=vi.fn(async()=>new Response(JSON.stringify({card}),{status:200}));
    vi.stubGlobal("fetch",fetch);
    const runtimeIdentity={registrationId:"runtime-registration",executionCommandId:"runtime-command"};
    const h=harness({executionRegistration:runtimeIdentity});
    const result=await h.call("start_card_work",{card_id:"card-1",expected_version:3,idempotency_key:"stable",turnId:"attacker",execution:{registrationId:"attacker"}});
    expect(result.isError).not.toBe(true);
    const [url,init]=fetch.mock.calls[0]! as unknown as [string,RequestInit];
    expect(url).toBe("https://orch.test/api/cards/card-1/start-work");
    expect(JSON.parse(String(init.body))).toEqual({expectedVersion:3,idempotencyKey:"stable",execution:runtimeIdentity});
    expect(h.entries.get("start_card_work")!.config.inputSchema).not.toHaveProperty("execution");
    expect(h.entries.get("start_card_work")!.config.inputSchema).not.toHaveProperty("turnId");
  });
  it("denies a purpose execution or missing runtime identity before HTTP", async () => {
    const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
    for (const task of [undefined,{executionRegistration:{registrationId:"reg",executionCommandId:"cmd"},orchestrationPurpose:{type:"card_orchestration_decision"}}]) {
      expect((await harness(task).call("start_card_work",{card_id:"card-1",expected_version:3,idempotency_key:"denied"})).isError).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("injects the same card context for agent and browser sessions using sessions.card_id", async () => {
    const snapshots: unknown[] = [];
    for (const source of ["agent", "browser"]) {
    const db = { getSession: vi.fn().mockResolvedValue({ folder_id: "folder-1", card_id: "card-1" }),
      getFolderById: vi.fn().mockResolvedValue({ id: "folder-1", name: "폴더" }),
      getCard: vi.fn().mockResolvedValue({ ...detail, card: { ...card, folderId: "moved-folder" } }),
      getPrimarySessionBoardItem: vi.fn() };
    const context = await resolvePrimarySessionFolderContext(db as unknown as SessionDB, logger, "session-1", "folder-1");
    const item = buildSoulstreamContextItem({ agentSessionId: "session-1", workspaceDir: "/workspace", callerInfo: { source }, ...context } as any);
    const content = item.content as Record<string, unknown>;
    snapshots.push({ card: content.card, card_guidance: content.card_guidance });
    expect(content.folder_guidance).toContain("카드");
    expect(content).not.toHaveProperty("source_checklist_item_id");
    expect(db.getPrimarySessionBoardItem).not.toHaveBeenCalled();
    expect(db.getCard).toHaveBeenCalledWith("card-1", "session-1");
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[0]).toMatchInlineSnapshot(`
      {
        "card": {
          "id": "card-1",
          "status": "running",
          "title": "카드",
        },
        "card_guidance": "이 세션은 카드 card-1를 맡았다. 경과는 update_card_brief, 보고는 add_card_report, 검수는 request_card_review, 질문은 ask_card_question으로 남긴다. AskUserQuestion은 쓰지 않는다.",
      }
    `);
  });
  it("passes cardId at session registration and keeps it out of board projection", async () => {
    const h = makeTaskCreationHarness();
    await h.creation.createTask({ agentSessionId: "session-1", prompt: "작업", folderId: "folder-1", cardId: "card-1" } as any);
    await h.creation.waitForDeferredEffects("session-1");
    expect(h.registerSession.mock.calls[0][0]).toMatchObject({ cardId: "card-1" });
    expect(h.upsertSessionBoardItem.mock.calls[0][0]).not.toHaveProperty("cardId");
  });
});
