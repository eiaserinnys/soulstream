import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PageRepository } from "../../../orch-server-ts/src/page/page_repository.js";
import { PageYjsService } from "../../../orch-server-ts/src/page/page_service.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createLiveAtomHttpClient } from "../../../orch-server-ts/src/runtime/live_atom_route_provider.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
import { withMcpRequestContext, type McpRequestContext } from "../../src/mcp/request_context.js";
import { createGuardedMcpServer } from "../../src/mcp/tool_access.js";
import { skillTools as skillDefinitions } from "@soulstream/mcp-contract";
import * as hostTransport from "../../src/control_plane/persistence_host_transport.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import * as pageTools from "../../src/mcp/tools/page.js";
import * as liveTools from "../../src/mcp/tools/live_card_view.js";
import * as skillTools from "../../src/mcp/tools/skills.js";

const internal: McpRequestContext = { callerSessionId: "agent-session" };
const external: McpRequestContext = { ...internal, principal: { authority: "external", source: "llm", displayName: "External" } };
const create = { id: "new-page", title: "새 페이지", idempotency_key: "new-key" };
const batch = { page_id: "seed", expected_version: 1, idempotency_key: "batch-key", operations: [{ op: "rename_page", title: "변경" }] };
type Case = [string, string, Record<string, unknown>, McpRequestContext?, boolean?, number?];
const cases: Case[] = [
  ["get blocks", "get_page", { page_id: "seed" }],
  ["get no blocks", "get_page", { page_id: "seed", include_blocks: false }],
  ["get missing", "get_page", { page_id: "missing" }, internal, true],
  ["find exact", "find_page", { title: " SEED " }],
  ["find missing", "find_page", { title: "missing" }],
  ["markdown", "get_page_markdown", { page_id: "seed" }],
  ["markdown ids", "get_page_markdown", { page_id: "seed", include_block_ids: true }],
  ["markdown missing", "get_page_markdown", { page_id: "missing" }, internal, true],
  ["backlinks default", "get_backlinks", { page_id: "seed" }],
  ["backlinks kind and limit", "get_backlinks", { page_id: "seed", kinds: ["mount"], limit: 1, include_self: true }],
  ["create", "create_page", create],
  ["create same key twice", "create_page", create, internal, false, 2],
  ["batch existing", "batch_page_operations", batch],
  ["batch new", "batch_page_operations", { page: { id: "new-batch", title: "배치" }, idempotency_key: "new-batch", operations: batch.operations }],
  ["batch both ids", "batch_page_operations", { ...batch, page: { title: "둘" } }, internal, true],
  ["batch no version", "batch_page_operations", { ...batch, expected_version: undefined }, internal, true],
  ["batch new with version", "batch_page_operations", { page: { title: "새" }, expected_version: 1, idempotency_key: "invalid", operations: batch.operations }, internal, true],
  ["batch conflict", "batch_page_operations", { ...batch, expected_version: 999 }, internal, true],
  ["batch missing", "batch_page_operations", { ...batch, page_id: "missing" }, internal, true],
  ["batch delete internal", "batch_page_operations", { ...batch, operations: [{ op: "delete_block_subtree", block_id: "seed-block" }] }],
  ["batch delete external", "batch_page_operations", { ...batch, operations: [{ op: "delete_block_subtree", block_id: "seed-block" }] }, external, true],
  ["upsert new", "upsert_page_markdown", { title: "새 마크다운", markdown: "첫 줄", idempotency_key: "markdown-new" }],
  ["upsert existing", "upsert_page_markdown", { page_id: "seed", expected_version: 1, markdown: "첫 줄", idempotency_key: "markdown-existing" }],
  ["upsert both ids", "upsert_page_markdown", { page_id: "seed", title: "둘", markdown: "", expected_version: 1, idempotency_key: "invalid" }, internal, true],
  ["upsert no version", "upsert_page_markdown", { page_id: "seed", markdown: "", idempotency_key: "invalid" }, internal, true],
  ["upsert new with version", "upsert_page_markdown", { title: "새", markdown: "", expected_version: 1, idempotency_key: "invalid" }, internal, true],
  ["upsert missing", "upsert_page_markdown", { page_id: "missing", markdown: "", expected_version: 1, idempotency_key: "invalid" }, internal, true],
  ["upsert conflict", "upsert_page_markdown", { page_id: "seed", markdown: "", expected_version: 999, idempotency_key: "invalid" }, internal, true],
  ["daily implicit", "get_daily_page", {}],
  ["daily explicit new", "get_daily_page", { date: "2026-08-02" }],
  ["daily existing", "get_daily_page", { date: "2026-08-02" }, internal, false, 2],
  ["external read", "get_page", { page_id: "seed", caller_session_id: "spoofed" }, external],
  ["external write", "create_page", { ...create, caller_session_id: "spoofed" }, external],
  ["missing actor", "create_page", create, {}, true],
  ["explicit actor", "create_page", { ...create, caller_session_id: " argument-session " }],
  ["live open all", "show_live_card_view", {}],
  ["live refresh folder", "list_live_cards", { folder_id: "folder-a", limit: 2 }],
  ["live bounded 100", "show_live_card_view", { limit: 100 }],
  ["live failed", "list_live_cards", { folder_id: "failure" }, internal, true],
  ["live external", "show_live_card_view", {}, external],
  ["skill exact", "search_skills", { query: " Skill-1 " }, internal, false, 2],
  ["skill ranked", "search_skills", { query: "rank", limit: 2 }],
  ["skill default five", "search_skills", { query: "rank" }],
  ["skill disabled", "search_skills", { query: "disabled" }, internal, true],
  ["skill API failure", "search_skills", { query: "api-failure" }, internal, true],
  ["skill atom error", "search_skills", { query: "atom-error" }, internal, true],
  ["skill atom empty", "search_skills", { query: "atom-empty" }, internal, true],
  ["skill atom exception", "search_skills", { query: "atom-exception" }, internal, true],
  ["skill missing key", "search_skills", { query: "missing-key" }, internal, true],
  ["skill external", "search_skills", { query: "skill-1" }, external],
];

describe("pages/live/skills MCP host roundtrip", () => {
  let h: PagePostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let service: PageYjsService;
  let runtime: McpRuntime;
  let pageOptions: any;
  let skillOptions: any;
  let hostCalls = 0;
  let query = "";
  const nativeFetch = globalThis.fetch;
  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO sessions(session_id) VALUES('agent-session'),('argument-session')`;
    pageOptions = { service: undefined, authBearerToken: "token", logger: { error: vi.fn() } };
    const cards = { cardServiceProvider: async () => ({
      listCards: async ({ folderId }: { folderId?: string }) => {
        if (folderId === "failure") throw Object.assign(new Error("denied"), { statusCode: 403 });
        return Array.from({ length: 101 }, (_, i) => ({ id: String(i), title: `카드 ${i}`, status: "todo", folder_id: "folder-a", latestActivity: { kind: "instruction", format: "markdown", body: "**최신**" } }));
      }, projectCards: async (rows: unknown) => rows,
    }), provider: { listFolders: async () => [{ id: "folder-a" }] }, resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) };
    skillOptions = { enabled: true, serverUrl: "https://atom.test", apiKey: "atom", nodeId: "", typesafeApiKey: "typesafe", logger: { warn: vi.fn() }, httpClient: createLiveAtomHttpClient({ fetch: async (url, init) => fakeFetch(url, init) }) };
    app = Fastify();
    app.addHook("onRequest", async request => { if (request.url.startsWith("/api/mcp/host/")) hostCalls++; });
    registerMcpHostRoutes(app, { authBearerToken: "token", pages: pageOptions, skills: skillOptions, cards, folders: {} } as never);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer token" } };
    const logger = { warn: vi.fn() } as never;
    runtime = { nodeId: "test", orch, logger } as unknown as McpRuntime;
    vi.stubGlobal("fetch", fakeFetch);
  }, 60_000);
  afterAll(async () => { vi.unstubAllGlobals(); await app?.close(); await service?.close(); await h?.cleanup(); });
  async function fakeFetch(input: any, init?: RequestInit): Promise<Response> {
    const url = String(input);
    if (url.startsWith("https://atom.test")) {
      if (query === "atom-exception") throw new Error("timeout");
      expect(new URL(url).search).toBe("?depth=1&max_chars=50000&include_ids=true");
      const markdown = Array.from({ length: 7 }, (_, i) => `## skill-${i}\ndescription: 스킬 ${i}\nbody_node_id: 00000000-0000-4000-8000-00000000000${i}`).join("\n\n");
      return Response.json({ markdown: query === "atom-empty" ? "" : markdown }, { status: query === "atom-error" ? 503 : 200 });
    }
    if (url.startsWith("https://api.typesafe.ai/")) {
      if (query === "api-failure") return new Response("failed", { status: 503 });
      const body = JSON.parse(String(init?.body));
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map((key, i) => [key, { score: 7 - i }])) });
    }
    return nativeFetch(input, init);
  }
  async function seed() {
    await service?.close();
    await h.sql`TRUNCATE sessions,pages,board_yjs_documents CASCADE`;
    await h.sql`INSERT INTO sessions(session_id) VALUES('agent-session'),('argument-session')`;
    service = new PageYjsService({ repository: new PageRepository(createLiveDbSqlResolver({ sql: h.liveSql })), createPageId: () => "daily-id", now: () => new Date("2026-07-11T15:30:00Z") });
    pageOptions.service = service;
    await service.createPage({ page: { id: "seed", title: "Seed", dailyDate: null }, actor: { actorKind: "agent", actorSessionId: "agent-session", actorUserId: null }, idempotencyKey: "create_page:agent-session:seed", initialCommand: { type: "replace_page_markdown", blocks: [{ id: "seed-block", parentId: null, positionKey: "a0", type: "paragraph", text: "[[Seed]]", properties: {}, collapsed: false }] } });
    const nodeId = randomUUID();
    Object.assign(skillOptions, { nodeId, enabled: query !== "disabled", typesafeApiKey: query === "missing-key" ? "" : "typesafe" });
  }
  async function call(name: string, input: Record<string, unknown>, ctx: McpRequestContext) {
    const server = new McpServer({ name: "parity", version: "1" });
    const guarded = createGuardedMcpServer(server, runtime);
    withMcpRequestContext(ctx, () => {
      pageTools.registerPageTools(guarded, runtime);
      skillTools.registerSkillsTools(guarded, runtime);
      liveTools.registerLiveCardView(guarded, runtime);
    });
    const client = new Client({ name: "parity-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try { await server.connect(st); await client.connect(ct); return await withMcpRequestContext(ctx, () => client.callTool({ name, arguments: input })); }
    finally { await client.close(); await server.close(); }
  }
  it.each(cases)("preserves %s", async (_label, name, input, ctx = internal, error = false, repeats = 1) => {
    query = String(input.query ?? "");
    input = { ...input, ...(input.idempotency_key ? { idempotency_key: `${name}:agent-session:${input.idempotency_key}` } : {}) };
    await seed(); const before = hostCalls; let next: any;
    for (let i = 0; i < repeats; i++) next = await call(name, input, ctx);
    expect(next.isError === true).toBe(error);
    expect(serialize(name === "upsert_page_markdown" && input.title ? "upsert_page_markdown:new" : name, next)).toMatchSnapshot();
    if (!error) expect(hostCalls - before).toBe(repeats);
    if (name === "create_page" && ctx === external) expect(next.structuredContent.operation).toMatchObject({ actor_kind: "llm", actor_session_id: null });
  });
  it("enforces external deletion on raw host calls", async () => {
    const response = await app.inject({ method: "POST", url: "/api/mcp/host/batch_page_operations", headers: { authorization: "Bearer token" }, payload: { args: { ...batch, operations: [{ op: "delete_block_subtree", block_id: "seed-block" }] }, context: { principal: "external", caller_session_id: "spoofed", node_id: "test" } } });
    expect(response.statusCode).toBe(200); expect(response.json().isError).toBe(true);
  });
  it("uses the catalog definition forwarding timeout", async () => {
    query = "";
    await seed();
    const request = vi.spyOn(hostTransport, "fetchOrchResponse");
    try {
      const result = await call("search_skills", { query: "skill-1" }, internal);
      expect(result.isError).not.toBe(true);
      expect(skillDefinitions.search_skills.timeoutMs).toBe(190000);
      expect(request).toHaveBeenCalledWith(runtime.orch, "POST", "/api/mcp/host/search_skills", expect.anything(), { timeoutMs: 190000, signal: expect.any(AbortSignal) });
    } finally { request.mockRestore(); }
  });
});

// Relative to parsed content and structuredContent. IDs generated by page_mutation_core.ts
// createPageMutationCore (operation UUID) and MCP upsert handler (page/block randomUUID).
const randomPaths: Record<string, string[]> = {
  create_page: ["operation.id"], batch_page_operations: ["operation.id"], get_daily_page: ["operation.id"],
  "upsert_page_markdown:new": ["page.id", "operation.id", "operation.page_id", "blocks.0.id", "blocks.0.page_id"],
  upsert_page_markdown: ["operation.id", "blocks.0.id"],
};
function mask(tool: string, value: any, path = ""): any {
  if (randomPaths[tool]?.includes(path)) return "<random>";
  if (Array.isArray(value)) return value.map((v, i) => mask(tool, v, `${path}.${i}`));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, /_at$|At$/.test(key) && v !== null ? "<time>" : mask(tool, v, path ? `${path}.${key}` : key)]));
}
function serialize(tool: string, value: any) {
  return JSON.stringify({ ...value, content: value.content.map((item: any) => {
    if (item.type !== "text" || value.isError) return item;
    let parsed; try { parsed = JSON.parse(item.text); } catch { return item; }
    expect(item.text).toBe(JSON.stringify(parsed, null, 2));
    return { ...item, text: JSON.stringify(mask(tool, parsed), null, 2) };
  }), ...(value.structuredContent === undefined ? {} : { structuredContent: mask(tool, value.structuredContent) }) });
}
describe("page result masking", () => {
  it("masks specified operation ids and timestamps", () => {
    expect(mask("create_page", { operation: { id: "random" }, updated_at: "now", page: { id: "seed" } }))
      .toEqual({ operation: { id: "<random>" }, updated_at: "<time>", page: { id: "seed" } });
    expect(mask("upsert_page_markdown", { page: { id: "seed" }, blocks: [{ id: "random" }], completed_at: null }))
      .toEqual({ page: { id: "seed" }, blocks: [{ id: "<random>" }], completed_at: null });
  });
});
