import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PageRepository } from "../../../orch-server-ts/src/page/page_repository.js";
import { PageYjsService } from "../../../orch-server-ts/src/page/page_service.js";
import { createLiveDbSqlResolver } from "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { createLiveAtomHttpClient } from "../../../orch-server-ts/src/runtime/live_atom_route_provider.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "../../../orch-server-ts/tests/page/page_postgres_harness.js";
type McpRequestContext = { callerSessionId?: string; principal?: { authority: string; source: string; displayName: string } };
import { executeMcpTool } from "../../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../../src/mcp/types.js";
import { skillTools as skillDefinitions } from "@soulstream/mcp-contract";
import * as hostTransport from "../../../soul-server-ts/src/control_plane/persistence_host_transport.js";

const internal: McpRequestContext = { callerSessionId: "agent-session" };
const external: McpRequestContext = { ...internal, principal: { authority: "external", source: "llm", displayName: "External" } };
const create = { id: "new-page", title: "새 페이지", idempotency_key: "new-key" };
const batch = { page_id: "seed", expected_version: 1, idempotency_key: "batch-key", operations: [{ op: "rename_page", title: "변경" }] };
type Case = [string, string, Record<string, unknown>, McpRequestContext?, boolean?, number?];
const cases: Case[] = [["external read", "get_page", { page_id: "seed", caller_session_id: "spoofed" }, external],
["external write", "create_page", { ...create, caller_session_id: "spoofed" }, external],
["live external", "show_live_card_view", {}, external],
["skill external", "search_skills", { query: "skill-1" }, external]];

describe("pages/live/skills MCP host roundtrip", () => {
  let h: PagePostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let service: PageYjsService;
  let executionOptions: McpHostOptions;
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
    executionOptions = { authBearerToken: "token", pages: pageOptions, skills: skillOptions, cards, folders: {} } as never as unknown as McpHostOptions;
    registerMcpHostRoutes(app, executionOptions);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const orch = { baseUrl, headers: { authorization: "Bearer token" } };
    const logger = { warn: vi.fn() } as never;
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
    const value = await executeMcpTool(executionOptions, name as never, input as Record<string, unknown>, { principal: "external", callerSessionId: null, nodeId: "test" });
    const { isError, content, structuredContent, ...rest } = value;
    return { ...rest, content, ...(structuredContent === undefined ? {} : { structuredContent }), ...(isError === undefined ? {} : { isError }) };
  }
  it.each(cases.filter(row => row.includes(external) && row[0] !== "batch delete external"))("preserves %s", async (_label, name, input, ctx = internal, error = false, repeats = 1) => {
    query = String(input.query ?? "");
    input = { ...input, ...(input.idempotency_key ? { idempotency_key: `${name}:agent-session:${input.idempotency_key}` } : {}) };
    await seed(); const before = hostCalls; let next: any;
    for (let i = 0; i < repeats; i++) next = await call(name, input, ctx);
    expect(next.isError === true).toBe(error);
    expect(serialize(name === "upsert_page_markdown" && input.title ? "upsert_page_markdown:new" : name, next)).toMatchSnapshot();
    
    if (name === "create_page" && ctx === external) expect(next.structuredContent.operation).toMatchObject({ actor_kind: "llm", actor_session_id: null });
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
});
