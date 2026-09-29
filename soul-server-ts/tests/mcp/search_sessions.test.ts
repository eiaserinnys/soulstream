import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import { registerSessionQueryTools } from "../../src/mcp/tools/session_query.js";

type InputSchema = Record<string, {
  safeParse(value: unknown): { success: boolean };
  parse(value: unknown): unknown;
}>;

type ToolHandler = (
  input: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

type RegisteredTool = {
  config: { description: string; inputSchema: InputSchema };
  handler: ToolHandler;
};

const orch = {
  baseUrl: "http://orch.test",
  headers: { authorization: "Bearer service-token" },
};

describe("search_sessions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("excludes the calling session and requests one extra result", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      search_status: { search: { status: "complete" } },
      session_results: [
        searchResult("session-1", "첫 번째 결과"),
        searchResult("caller-session", "현재 세션"),
        searchResult("session-2", "두 번째 결과"),
      ],
    }));
    vi.stubGlobal("fetch", fetch);
    const { call } = register();

    const result = await withMcpRequestContext(
      { callerSessionId: "caller-session" },
      () => call({ query: "세션 검색", top_k: 2 }),
    );

    expect((result.structuredContent?.results as Array<{ session_id: string }>).map(
      ({ session_id }) => session_id,
    )).toEqual(["session-1", "session-2"]);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("top_k")).toBe("3");
  });

  it("keeps the requested result count when the caller session is unknown", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      search_status: { search: { status: "complete" } },
      session_results: [
        searchResult("session-1", "첫 번째 결과"),
        searchResult("session-2", "두 번째 결과"),
      ],
    }));
    vi.stubGlobal("fetch", fetch);
    const { call } = register();

    const result = await call({ query: "세션 검색", top_k: 2 });

    expect((result.structuredContent?.results as Array<{ session_id: string }>).map(
      ({ session_id }) => session_id,
    )).toEqual(["session-1", "session-2"]);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("top_k")).toBe("2");
  });

  it("maps session rows and sends the expanded search parameters", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      search_status: { search: { status: "complete" } },
      session_results: [{
        session_id: "session-1",
        title: "요청한 작업",
        agent_name: "로젤린",
        node_id: "eiaserinnys",
        status: "completed",
        created_at: "2026-09-27T00:00:00.000Z",
        updated_at: "2026-09-28T00:00:00.000Z",
        folder_title: "세션 검색",
        relevance: 0.87,
        best_match: { excerpt: "요청을 찾아 정리했다." },
        session_url: "https://soulstream.test/sessions/session-1",
      }],
    }));
    vi.stubGlobal("fetch", fetch);
    const { call } = register();

    const result = await call({ query: "세션 검색", top_k: 4, folder_id: "folder-1" });

    expect(result.structuredContent).toEqual({
      query: "세션 검색",
      status: "complete",
      partial_reason: null,
      results: [{
        session_id: "session-1",
        title: "요청한 작업",
        agent_name: "로젤린",
        node_id: "eiaserinnys",
        status: "completed",
        created_at: "2026-09-27T00:00:00.000Z",
        updated_at: "2026-09-28T00:00:00.000Z",
        folder_title: "세션 검색",
        relevance: 0.87,
        excerpt: "요청을 찾아 정리했다.",
        session_url: "https://soulstream.test/sessions/session-1",
      }],
    });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/cogito/search");
    expect([...url.searchParams.entries()]).toEqual([
      ["q", "세션 검색"],
      ["top_k", "4"],
      ["include_session_results", "true"],
      ["session_search_mode", "expanded"],
      ["search_session_id", "true"],
      ["session_folder_id", "folder-1"],
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer service-token" },
    });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps missing relevance and excerpt to null for the pre-PR1 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      search_status: { search: { status: "complete" } },
      session_results: [{
        session_id: "session-2",
        title: "기존 세션",
        agent_name: null,
        node_id: "eiaserinnys",
        status: "completed",
        updated_at: null,
        folder_title: null,
        best_match: null,
        session_url: null,
      }],
    })));
    const { call } = register();

    const result = await call({ query: "기존 세션" });

    expect(result.structuredContent).toMatchObject({
      results: [{ relevance: null, excerpt: null }],
    });
  });

  it("marks partial search status and carries its reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      search_status: { search: { status: "partial", reason: "timeout" } },
      session_results: [],
    })));
    const { call } = register();

    const result = await call({ query: "timeout" });

    expect(result.structuredContent).toEqual({
      query: "timeout",
      status: "partial",
      partial_reason: "timeout",
      results: [],
    });
  });

  it("defaults top_k to 10 and omits the folder parameter", async () => {
    const fetch = vi.fn().mockResolvedValue(response({
      search_status: { search: { status: "complete" } },
      session_results: [],
    }));
    vi.stubGlobal("fetch", fetch);
    const { call } = register();

    await call({ query: "query" });

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("top_k")).toBe("10");
    expect(url.searchParams.has("session_folder_id")).toBe(false);
  });

  it("enforces query and top_k bounds and keeps folder_id optional", () => {
    const { registered } = register();
    const schema = registered.get("search_sessions")!.config.inputSchema;

    expect(schema.query.safeParse("").success).toBe(false);
    expect(schema.query.safeParse("x".repeat(501)).success).toBe(false);
    expect(schema.top_k.safeParse(0).success).toBe(false);
    expect(schema.top_k.safeParse(31).success).toBe(false);
    expect(schema.top_k.safeParse(1.5).success).toBe(false);
    expect(schema.top_k.parse(undefined)).toBe(10);
    expect(schema.folder_id.safeParse(undefined).success).toBe(true);
  });

  it("returns orch HTTP failures through errorResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: "orch unavailable" }),
      { status: 503 },
    )));
    const { call } = register();

    const result = await call({ query: "retry" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toContain("503");
    expect(result.structuredContent?.error).toContain("orch unavailable");
  });

  it("returns network failures through errorResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const { call } = register();

    const result = await call({ query: "retry" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "network down" });
  });

  it("documents session-level search alongside event search", () => {
    const { registered } = register();

    expect(registered.get("search_sessions")?.config.description).toBe(
      "과거 세션을 뜻으로 찾는다. 검색어가 가리키는 작업이나 대화를 한 세션을 관련도 순으로 돌려준다. 원문 이벤트 조각(특정 문장, 도구 출력)이 필요하면 search_session_history를 쓴다.",
    );
    expect(registered.get("search_session_history")?.config.description).toContain(
      "세션 단위로 찾을 때는 search_sessions를 먼저 쓴다.",
    );
  });
});

function register() {
  const registered = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: unknown, handler: unknown) {
      registered.set(name, {
        config: config as RegisteredTool["config"],
        handler: handler as ToolHandler,
      });
    },
  } as unknown as McpServer;
  registerSessionQueryTools(server, {
    orch,
  } as unknown as McpRuntime);

  return {
    registered,
    async call(input: Record<string, unknown>) {
      const tool = registered.get("search_sessions");
      if (!tool) throw new Error("missing tool: search_sessions");
      return await tool.handler(input, { signal: new AbortController().signal });
    },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function searchResult(sessionId: string, title: string) {
  return {
    session_id: sessionId,
    title,
    agent_name: null,
    node_id: null,
    status: null,
    updated_at: null,
    folder_title: null,
    relevance: null,
    best_match: null,
    session_url: null,
  };
}
