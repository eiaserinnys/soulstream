import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerCardTools } from "../../src/mcp/tools/card_tools.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { resolvePrimarySessionFolderContext } from "../../src/context/session_folder_context.js";
import { buildSoulstreamContextItem } from "../../src/context/soulstream_item.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { makeTaskCreationHarness } from "../task/task_creation_harness.js";

// Reuses folder.test.ts tool registration and task_creation.test.ts creation harness;
// direct callbacks isolate the new card wire contract without opening an MCP server.
const names = ["create_card", "list_cards", "get_card", "update_card_brief", "add_card_report", "add_card_comment",
  "request_card_review", "ask_card_question", "move_card", "start_card_work", "set_card_status"];
const logger = pino({ level: "silent" });
const attachments=[{nodeId:"node",path:"/incoming/upload/image.png",name:"image.png",mimeType:"image/png"}];
const card = { id: "card-1", folderId: "folder-1", title: "카드", status: "running", version: 3, attachments };
const detail = { card, reports: [{ title: "보고" }], questions: [], comments: [{ body: "지시 요점", kind: "spoken" }], sessions: [] };
function harness(task?:Record<string,unknown>) {
  const entries = new Map<string, { config: { inputSchema: z.ZodRawShape }; callback: (input: unknown, request: unknown) => Promise<any> }>();
  registerCardTools({ registerTool: (name: string, config: any, callback: any) => entries.set(name, { config, callback }) } as unknown as McpServer,
    { nodeId: "node", orch: { baseUrl: "https://orch.test", headers: { authorization: "Bearer test-service" } }, logger, taskManager:{getTask:()=>task} } as unknown as McpRuntime);
  return { entries, call: async (name: string, input: object) => {
    const entry = entries.get(name)!;
    return entry.callback(z.object(entry.config.inputSchema).parse({ caller_session_id: "session-1", ...input }), { signal: new AbortController().signal });
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
  it("derives work execution only from runtime and preserves supplied CAS/idempotency", async () => {
    const fetch=vi.fn(async()=>Response.json({ content: [], structuredContent: {card} }));
    vi.stubGlobal("fetch",fetch);
    const runtimeIdentity={registrationId:"runtime-registration",executionCommandId:"runtime-command"};
    const h=harness({executionRegistration:runtimeIdentity});
    const result=await h.call("start_card_work",{card_id:"card-1",expected_version:3,idempotency_key:"stable",turnId:"attacker",execution:{registrationId:"attacker"}});
    expect(result.isError).not.toBe(true);
    const [url,init]=fetch.mock.calls[0]! as unknown as [string,RequestInit];
    expect(url).toBe("https://orch.test/api/mcp/host/start_card_work");
    expect(JSON.parse(String(init.body))).toEqual({
      args: { card_id: "card-1", caller_session_id: "session-1", expected_version: 3, idempotency_key: "stable" },
      context: { principal: "internal", caller_session_id: null, node_id: "node", execution: runtimeIdentity },
    });
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
