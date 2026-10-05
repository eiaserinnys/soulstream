import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { SessionDB } from "../../src/db/session_db.js";
import { FolderHostClient } from "../../src/folder/folder_host_client.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { createInventoryMcpServer } from "../../src/mcp/tool_access.js";

// Real proxy, real MCP SDK, real SessionDB -> FolderHostClient. Only the central's HTTP answer is stubbed.
const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
const orch = { baseUrl: "https://orch.example", headers: { authorization: "Bearer token" } };
const answer = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const FULL_CARD_ID = "9f3e1c2a-0000-4000-8000-000000000007";
const FULL_SESSION_ID = "5d0c1a2b-0000-4000-8000-000000000001";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function resolved(refs: string[]) {
  return refs.map(ref => ref === "#7"
    ? { ref, kind: "card", id: FULL_CARD_ID, title: "퍼시스턴트 에이전트 세션" }
    : { ref, kind: "session", id: FULL_SESSION_ID, title: "🔨 P6 체크포인트 조립" });
}

async function connect(central: (refs: string[]) => Response) {
  const lookups = vi.fn(async (_url: string, init?: RequestInit) => central(JSON.parse(String(init?.body)).refs));
  vi.stubGlobal("fetch", lookups);
  const db = new SessionDB();
  db.configureFolderHost(new FolderHostClient({ orch, logger }));
  const handlers = {
    card: vi.fn(async (_args: unknown, _extra: unknown) => ({
      ...answer("카드 처리기"),
      structuredContent: { card: { id: FULL_CARD_ID, number: 7 } },
    })),
    session: vi.fn(async (_args: unknown, _extra: unknown) => answer("세션 처리기")),
    remove: vi.fn(async (_args: unknown, _extra: unknown) => answer("삭제 처리기")),
    ping: vi.fn(async (_extra: unknown) => answer("인자 없는 처리기")),
  };
  const server = new McpServer({ name: "translation", version: "1" });
  const guarded = createInventoryMcpServer(server, { db } as unknown as McpRuntime);
  guarded.registerTool("get_card", { inputSchema: { card_id: z.string() } }, handlers.card as never);
  guarded.registerTool("get_session_summary", { inputSchema: { session_id: z.string() } }, handlers.session as never);
  guarded.registerTool("delete_session", { inputSchema: { session_id: z.string() } }, handlers.remove as never);
  guarded.registerTool("ping", { description: "no input schema" }, handlers.ping as never);
  const client = new Client({ name: "translation-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, handlers, lookups, close: async () => { await client.close(); await server.close(); } };
}

describe("worker MCP card reference translation", () => {
  it("passes a full ID through untouched without asking the central", async () => {
    const t = await connect(() => { throw new Error("central must not be asked"); });
    try {
      const result = await t.client.callTool({ name: "get_card", arguments: { card_id: FULL_CARD_ID } });
      expect(t.lookups).not.toHaveBeenCalled();
      expect(t.handlers.card).toHaveBeenCalledOnce();
      expect(t.handlers.card.mock.calls[0]![0]).toEqual({ card_id: FULL_CARD_ID });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "카드 처리기" }]);
    } finally { await t.close(); }
  });

  it("translates a #N card argument with one lookup and puts the title first", async () => {
    const t = await connect(refs => Response.json(resolved(refs)));
    try {
      const result = await t.client.callTool({ name: "get_card", arguments: { card_id: "#7" } });
      expect(t.lookups).toHaveBeenCalledOnce();
      const [url, init] = t.lookups.mock.calls[0]!;
      expect(url).toBe("https://orch.example/api/folders/host/resolve_card_references");
      expect(JSON.parse(String(init?.body))).toEqual({ refs: ["#7"] });
      expect(t.handlers.card.mock.calls[0]![0]).toEqual({ card_id: FULL_CARD_ID });
      // The SDK's request context still reaches the handler (orchestrator tools read extra.signal).
      expect(t.handlers.card.mock.calls[0]![1]).toHaveProperty("signal");
      expect(result.content).toEqual([
        { type: "text", text: "번호 참조 #7 → 카드 「퍼시스턴트 에이전트 세션」" },
        { type: "text", text: "카드 처리기" },
      ]);
      expect(result.structuredContent).toMatchObject({
        resolved_references: ["번호 참조 #7 → 카드 「퍼시스턴트 에이전트 세션」"],
      });
    } finally { await t.close(); }
  });

  it("translates a #N.sK session argument", async () => {
    const t = await connect(refs => Response.json(resolved(refs)));
    try {
      const result = await t.client.callTool({ name: "get_session_summary", arguments: { session_id: "#7.s1" } });
      expect(t.handlers.session.mock.calls[0]![0]).toEqual({ session_id: FULL_SESSION_ID });
      expect(result.content?.[0]).toEqual({ type: "text", text: "번호 참조 #7.s1 → 세션 「🔨 P6 체크포인트 조립」" });
    } finally { await t.close(); }
  });

  it("returns an error result and skips the handler when the central does not know the lookup (404)", async () => {
    const t = await connect(() => Response.json({ detail: { error: { code: "FOLDER_OPERATION_NOT_FOUND",
      message: "unknown operation: resolve_card_references" } } }, { status: 404 }));
    try {
      const result = await t.client.callTool({ name: "get_card", arguments: { card_id: "#7" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("번호 참조를 해석하지 못했습니다");
      expect(JSON.stringify(result.content)).toContain("전체 ID로 다시 호출할 수 있습니다");
      expect(t.handlers.card).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("calls a tool without an inputSchema as the SDK does, with only the extra argument", async () => {
    const t = await connect(() => { throw new Error("central must not be asked"); });
    try {
      const result = await t.client.callTool({ name: "ping", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "인자 없는 처리기" }]);
      expect(t.handlers.ping).toHaveBeenCalledOnce();
      expect(t.handlers.ping.mock.calls[0]).toHaveLength(1);
      expect(t.handlers.ping.mock.calls[0]![0]).toHaveProperty("signal");
      expect(t.lookups).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("refuses a number reference for a deleting tool without any lookup or handler call", async () => {
    const t = await connect(() => { throw new Error("central must not be asked"); });
    try {
      const result = await t.client.callTool({ name: "delete_session", arguments: { session_id: "#7.s1" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("지우는 도구는 번호 참조를 받지 않습니다");
      expect(t.lookups).not.toHaveBeenCalled();
      expect(t.handlers.remove).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("still runs the deleting tool for a full session ID exactly as before", async () => {
    const t = await connect(() => { throw new Error("central must not be asked"); });
    try {
      const result = await t.client.callTool({ name: "delete_session", arguments: { session_id: FULL_SESSION_ID } });
      expect(result.content).toEqual([{ type: "text", text: "삭제 처리기" }]);
      expect(t.handlers.remove.mock.calls[0]![0]).toEqual({ session_id: FULL_SESSION_ID });
      expect(t.lookups).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("keeps advertising the deleting tool as destructive", async () => {
    const t = await connect(() => { throw new Error("central must not be asked"); });
    try {
      const tools = (await t.client.listTools()).tools;
      expect(tools.find(tool => tool.name === "delete_session")!.annotations).toMatchObject({ destructiveHint: true });
      expect(tools.find(tool => tool.name === "get_card")!.annotations?.destructiveHint).toBeUndefined();
    } finally { await t.close(); }
  });
});
