import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const DEFAULT_READABLE_SEARCH_EVENT_TYPES = [
  "user_message",
  "intervention_sent",
  "assistant_message",
  "result",
  "complete",
];

const openClients: Client[] = [];
const openServers: Awaited<ReturnType<typeof buildServer>>[] = [];

function createSilentLogger() {
  const noop = () => {};
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => createSilentLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(params: {
  searchEvents?: ReturnType<typeof vi.fn>;
  searchEventsBySessionId?: ReturnType<typeof vi.fn>;
  searchSessionDigests?: ReturnType<typeof vi.fn>;
  db?: Record<string, unknown>;
  childCompletionConsumption?: McpRuntime["childCompletionConsumption"];
}): McpRuntime {
  return {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {
      searchEvents: params.searchEvents ?? vi.fn(async () => []),
      searchEventsBySessionId: params.searchEventsBySessionId ?? vi.fn(async () => []),
      searchSessionDigests: params.searchSessionDigests ?? vi.fn(async () => []),
      getSessionSearchMetadata: vi.fn(async () => new Map()),
      ...params.db,
    } as unknown as SessionDB,
    taskManager: {} as TaskManager,
    taskExecutor: {} as TaskExecutor,
    ...(params.childCompletionConsumption
      ? { childCompletionConsumption: params.childCompletionConsumption }
      : {}),
    agentRegistry: {} as McpRuntime["agentRegistry"],
    catalogService: {} as CatalogService,
    logger: createSilentLogger(),
  };
}

async function createClient(
  runtime: McpRuntime,
  headers?: Record<string, string>,
): Promise<Client> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: runtime.nodeId,
    logger: createSilentLogger(),
    mcp: {
      runtime,
      path: "/mcp",
      auth: {
        requireAuth: false,
        bearerToken: "",
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    },
  });
  openServers.push(server);
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "session-query-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp`),
    headers ? { requestInit: { headers } } : undefined,
  ));
  openClients.push(client);
  return client;
}

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    try {
      await client?.close();
    } catch {
      // ignore cleanup failures
    }
  }
  while (openServers.length > 0) {
    const server = openServers.pop();
    try {
      if (server?.closeMcp) await server.closeMcp();
      await server?.close();
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("list_session_events", () => {
  it("marks truncated pages and gives the exact next cursor instruction", async () => {
    const events = [1, 2, 3].map((id) => ({
      id,
      event_type: "assistant_message",
      payload: { text: `message ${id}` },
      created_at: new Date("2026-07-16T00:00:00.000Z"),
    }));
    const runtime = makeRuntime({
      db: {
        getSession: vi.fn(async () => ({ session_id: "sess-1" })),
        readEvents: vi.fn(async () => events),
        countEvents: vi.fn(async () => 7),
      },
    });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "list_session_events",
      arguments: { session_id: "sess-1", cursor: 0, limit: 2 },
    });

    expect(result.structuredContent).toMatchObject({
      session_id: "sess-1",
      total: 7,
      limit: 2,
      cursor: 0,
      truncated: true,
      next_cursor: 2,
      notice: "7건 중 cursor 0부터 2건 표시. cursor=2로 계속 조회하세요.",
    });
    expect(result.structuredContent?.events).toHaveLength(2);
  });
});

describe("get_session_summary child completion", () => {
  it("fails closed when the durable relation cannot be recorded", async () => {
    const recordObservedBatch =
      vi.fn().mockRejectedValue(new Error("ledger unavailable"));
    const runtime = makeRuntime({
      db: {
        getSession: vi.fn(async () => ({
          session_id: "child-1",
          display_name: "Child",
          status: "completed",
          created_at: new Date("2026-07-26T00:00:00Z"),
          caller_session_id: "caller-1",
          last_event_id: 42,
        })),
        getTurnExcerpt: vi.fn(async () => ({ totalEvents: 0, turns: [] })),
      },
      childCompletionConsumption: {
        recordObserved: vi.fn(),
        recordObservedBatch,
      },
    });
    const client = await createClient(runtime, {
      "x-soulstream-agent-session-id": "caller-1",
    });

    const result = await client.callTool({
      name: "get_session_summary",
      arguments: { session_id: "child-1" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("ledger unavailable");
    expect(recordObservedBatch).toHaveBeenCalledWith([{
      childSessionId: "child-1",
      callerSessionId: "caller-1",
      source: "get_session_summary",
      terminalRevision: 42,
    }]);
  });
});

describe("get_session_story", () => {
  it("returns story source without the highlight body by default", async () => {
    const runtime = makeRuntime({
      db: {
        getSession: vi.fn(async () => ({
          session_id: "sess-1",
          status: "running",
          last_event_id: 42,
        })),
        getSessionStory: vi.fn(async () => ({
          highlight: "핵심 다섯 문장.",
          narrative: "[T1] 시작했다.",
          unfoldedTurnSummaries: [{
            eventId: 42,
            turnNumber: 6,
            content: "아직 접히지 않은 턴",
            turnStartEventId: 40,
            finalResponseEventId: 41,
            createdAt: new Date("2026-07-31T00:00:00.000Z"),
          }],
          narrativeThroughEventId: 35,
          foldCount: 1,
          updatedAt: new Date("2026-07-31T00:01:00.000Z"),
        })),
      },
    });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "get_session_story",
      arguments: { session_id: "sess-1" },
    });

    expect(result.structuredContent).toEqual({
      source: "story",
      narrative: "[T1] 시작했다.",
      unfolded_turn_summaries: [{
        event_id: 42,
        turn_number: 6,
        content: "아직 접히지 않은 턴",
        turn_start_event_id: 40,
        final_response_event_id: 41,
        created_at: "2026-07-31T00:00:00.000Z",
      }],
      narrative_through_event_id: 35,
      fold_count: 1,
      updated_at: "2026-07-31T00:01:00.000Z",
    });
  });

  it("includes the highlight body only when explicitly requested", async () => {
    const client = await createClient(makeRuntime({
      db: {
        getSession: vi.fn(async () => ({
          session_id: "sess-1",
          status: "running",
          last_event_id: 42,
        })),
        getSessionStory: vi.fn(async () => ({
          highlight: "핵심 다섯 문장.",
          narrative: "[T1] 시작했다.",
          unfoldedTurnSummaries: [],
          narrativeThroughEventId: 35,
          foldCount: 1,
          updatedAt: new Date("2026-07-31T00:01:00.000Z"),
        })),
      },
    }));

    const result = await client.callTool({
      name: "get_session_story",
      arguments: { session_id: "sess-1", include_highlight: true },
    });

    expect(result.structuredContent).toMatchObject({
      source: "story",
      highlight: "핵심 다섯 문장.",
      narrative: "[T1] 시작했다.",
    });
  });

  it("uses stored turn summaries as the explicit no-digest fallback", async () => {
    const runtime = makeRuntime({
      db: {
        getSession: vi.fn(async () => ({
          session_id: "sess-1",
          status: "running",
          last_event_id: 8,
        })),
        getSessionStory: vi.fn(async () => ({
          highlight: null,
          narrative: null,
          unfoldedTurnSummaries: [{
            eventId: 8,
            turnNumber: 1,
            content: "첫 턴",
            turnStartEventId: 2,
            finalResponseEventId: 7,
            createdAt: new Date("2026-07-31T00:00:00.000Z"),
          }],
          narrativeThroughEventId: null,
          foldCount: 0,
          updatedAt: null,
        })),
      },
    });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "get_session_story",
      arguments: { session_id: "sess-1" },
    });

    expect(result.structuredContent).toMatchObject({
      source: "turn_summaries",
      narrative: null,
      narrative_through_event_id: null,
      fold_count: 0,
      updated_at: null,
      unfolded_turn_summaries: [{ event_id: 8, turn_number: 1 }],
    });
    expect(result.structuredContent).not.toHaveProperty("highlight");
  });

  it("distinguishes a completely empty session", async () => {
    const client = await createClient(makeRuntime({
      db: {
        getSession: vi.fn(async () => ({
          session_id: "sess-1",
          status: "completed",
          last_event_id: 3,
        })),
        getSessionStory: vi.fn(async () => ({
          highlight: null,
          narrative: null,
          unfoldedTurnSummaries: [],
          narrativeThroughEventId: null,
          foldCount: 0,
          updatedAt: null,
        })),
      },
    }));

    const result = await client.callTool({
      name: "get_session_story",
      arguments: { session_id: "sess-1" },
    });

    expect(result.structuredContent).toMatchObject({
      source: "empty",
      narrative: null,
      unfolded_turn_summaries: [],
    });
  });
});

describe("get_session_highlight", () => {
  it("returns a stored highlight when a story digest exists", async () => {
    const client = await createClient(makeRuntime({
      db: {
        getSession: vi.fn(async () => ({ session_id: "sess-1", last_event_id: 42 })),
        getSessionStory: vi.fn(async () => ({
          highlight: "가장 중요한 다섯 문장.",
          narrative: "[T1-T5] 구현했다.",
          unfoldedTurnSummaries: [],
          narrativeThroughEventId: 40,
          foldCount: 1,
          updatedAt: new Date("2026-07-31T00:01:00.000Z"),
        })),
      },
    }));

    const result = await client.callTool({
      name: "get_session_highlight",
      arguments: { session_id: "sess-1" },
    });

    expect(result.structuredContent).toEqual({
      source: "story",
      highlight: "가장 중요한 다섯 문장.",
      updated_at: "2026-07-31T00:01:00.000Z",
    });
  });

  it("falls back to chronological stored summaries and distinguishes empty", async () => {
    const getSession = vi.fn(async (sessionId: string) => ({
      session_id: sessionId,
      last_event_id: 9,
    }));
    const getSessionStory = vi.fn(async (sessionId: string) => ({
      highlight: null,
      narrative: null,
      unfoldedTurnSummaries: sessionId === "with-summaries"
        ? [{
            eventId: 9,
            turnNumber: 1,
            content: "저장된 첫 턴",
            turnStartEventId: 1,
            finalResponseEventId: 8,
            createdAt: new Date("2026-07-31T00:00:00.000Z"),
          }]
        : [],
      narrativeThroughEventId: null,
      foldCount: 0,
      updatedAt: null,
    }));
    const client = await createClient(makeRuntime({
      db: { getSession, getSessionStory },
    }));

    const fallback = await client.callTool({
      name: "get_session_highlight",
      arguments: { session_id: "with-summaries" },
    });
    const empty = await client.callTool({
      name: "get_session_highlight",
      arguments: { session_id: "empty" },
    });

    expect(fallback.structuredContent).toEqual({
      source: "turn_summaries",
      turn_summaries: [{
        event_id: 9,
        turn_number: 1,
        content: "저장된 첫 턴",
        turn_start_event_id: 1,
        final_response_event_id: 8,
        created_at: "2026-07-31T00:00:00.000Z",
      }],
    });
    expect(empty.structuredContent).toEqual({
      source: "empty",
      turn_summaries: [],
    });
  });
});

describe("get_session_turn_summaries", () => {
  it("returns count, missing index, and a bounded chronological range", async () => {
    const loadTurnSummaryRange = vi.fn(async (
      _sessionId: string,
      from: number,
      to: number | null,
      limit: number,
    ) => {
      if (from === 9 && to === 9) return [];
      expect([from, to, limit]).toEqual([2, null, 2]);
      return [
        {
          eventId: 24,
          turnNumber: 2,
          content: "두 번째 턴",
          turnStartEventId: 15,
          finalResponseEventId: 22,
          createdAt: new Date("2026-07-31T00:01:00.000Z"),
        },
        {
          eventId: 36,
          turnNumber: 3,
          content: "세 번째 턴",
          turnStartEventId: 25,
          finalResponseEventId: 34,
          createdAt: new Date("2026-07-31T00:02:00.000Z"),
        },
      ];
    });
    const client = await createClient(makeRuntime({
      db: {
        getSession: vi.fn(async () => ({ session_id: "sess-1" })),
        countTurnSummaries: vi.fn(async () => ({
          totalCount: 4,
          digestedCount: 3,
          undigestedCount: 1,
        })),
        loadTurnSummaryRange,
      },
    }));

    const count = await client.callTool({
      name: "get_session_turn_summaries",
      arguments: { session_id: "sess-1", mode: "count" },
    });
    const missing = await client.callTool({
      name: "get_session_turn_summaries",
      arguments: {
        session_id: "sess-1",
        mode: "index",
        turn_number: 9,
      },
    });
    const range = await client.callTool({
      name: "get_session_turn_summaries",
      arguments: {
        session_id: "sess-1",
        mode: "range",
        from_turn_number: 2,
        limit: 1,
      },
    });

    expect(count.structuredContent).toEqual({
      session_id: "sess-1",
      mode: "count",
      total_count: 4,
      digested_count: 3,
      undigested_count: 1,
    });
    expect(missing.structuredContent).toEqual({
      session_id: "sess-1",
      mode: "index",
      turn_number: 9,
      summary: null,
    });
    expect(range.structuredContent).toEqual({
      session_id: "sess-1",
      mode: "range",
      from_turn_number: 2,
      to_turn_number: null,
      limit: 1,
      summaries: [{
        event_id: 24,
        turn_number: 2,
        content: "두 번째 턴",
        turn_start_event_id: 15,
        final_response_event_id: 22,
        created_at: "2026-07-31T00:01:00.000Z",
      }],
      has_more: true,
      next_from_turn_number: 3,
    });
  });

  it("records consumption only when the returned summaries reflect the terminal revision", async () => {
    const recordObservedBatch = vi.fn(async () => ({ status: "recorded" as const }));
    const client = await createClient(makeRuntime({
      db: {
        getSession: vi.fn(async () => ({
          session_id: "child-1",
          status: "completed",
          caller_session_id: "caller-1",
          last_event_id: 42,
        })),
        loadTurnSummaryRange: vi.fn(async (
          _sessionId: string,
          from: number,
        ) => from === 1
          ? [{
              eventId: 10,
              turnNumber: 1,
              content: "부분 조회",
              turnStartEventId: 1,
              finalResponseEventId: 9,
              createdAt: new Date("2026-07-31T00:00:00.000Z"),
            }]
          : [{
              eventId: 42,
              turnNumber: 2,
              content: "마지막 턴",
              turnStartEventId: 11,
              finalResponseEventId: 41,
              createdAt: new Date("2026-07-31T00:01:00.000Z"),
            }]),
        countTurnSummaries: vi.fn(async () => ({
          totalCount: 3,
          digestedCount: 2,
          undigestedCount: 1,
        })),
      },
      childCompletionConsumption: {
        recordObserved: vi.fn(),
        recordObservedBatch,
      },
    }), {
      "x-soulstream-agent-session-id": "caller-1",
    });

    const count = await client.callTool({
      name: "get_session_turn_summaries",
      arguments: { session_id: "child-1", mode: "count" },
    });
    expect(count.isError).not.toBe(true);
    expect(recordObservedBatch).not.toHaveBeenCalled();

    const partialIndex = await client.callTool({
      name: "get_session_turn_summaries",
      arguments: {
        session_id: "child-1",
        mode: "index",
        turn_number: 1,
      },
    });
    expect(partialIndex.isError).not.toBe(true);
    expect(recordObservedBatch).not.toHaveBeenCalled();

    const terminalRange = await client.callTool({
      name: "get_session_turn_summaries",
      arguments: {
        session_id: "child-1",
        mode: "range",
        from_turn_number: 2,
      },
    });
    expect(terminalRange.isError).not.toBe(true);
    expect(recordObservedBatch).toHaveBeenCalledWith([{
      childSessionId: "child-1",
      callerSessionId: "caller-1",
      source: "get_session_turn_summaries",
      terminalRevision: 42,
    }]);
  });
});

describe("search_session_history", () => {
  it("describes the explicit event_types needed to search tool events", async () => {
    const client = await createClient(makeRuntime({}));

    const tools = await client.listTools();
    const searchTool = tools.tools.find(
      (tool) => tool.name === "search_session_history",
    );

    expect(searchTool?.description).toContain(
      'event_types: ["tool_start","tool_result"]',
    );
  });

  it("defaults to readable event types", async () => {
    const searchEvents = vi.fn(async () => [
      {
        id: 1,
        session_id: "s1",
        event_type: "user_message",
        searchable_text: "hello readable world",
        score: 0.75,
      },
    ]);
    const runtime = makeRuntime({ searchEvents });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "search_session_history",
      arguments: { query: "hello" },
    });

    expect(result.isError).not.toBe(true);
    expect(searchEvents).toHaveBeenCalledWith(
      "hello",
      null,
      10,
      DEFAULT_READABLE_SEARCH_EVENT_TYPES,
    );
    expect(result.structuredContent).toEqual({
      results: [
        {
          session_id: "s1",
          event_id: 1,
          score: 0.75,
          preview: "hello readable world",
          event_type: "user_message",
          match_source: "message",
          turn_count: 0,
          has_turn_summaries: false,
          has_story_digest: false,
          has_highlight: false,
        },
      ],
    });
  });

  it("passes explicit tool event types to the shared search path", async () => {
    const searchEvents = vi.fn(async () => []);
    const runtime = makeRuntime({ searchEvents });
    const client = await createClient(runtime);

    await client.callTool({
      name: "search_session_history",
      arguments: {
        query: "search_cards",
        event_types: ["tool_start", "tool_result"],
      },
    });

    expect(searchEvents).toHaveBeenCalledWith(
      "search_cards",
      null,
      10,
      ["tool_start", "tool_result"],
    );
  });

  it("filters empty-preview session id matches by default", async () => {
    const searchEvents = vi.fn(async () => []);
    const searchEventsBySessionId = vi.fn(async () => [
      {
        id: 2,
        session_id: "sess-hello",
        event_type: "tool_start",
        searchable_text: "",
        score: 0.5,
      },
      {
        id: 3,
        session_id: "sess-hello",
        event_type: "user_message",
        searchable_text: "readable session match",
        score: 0.5,
      },
    ]);
    const runtime = makeRuntime({ searchEvents, searchEventsBySessionId });
    const client = await createClient(runtime);

    const result = await client.callTool({
      name: "search_session_history",
      arguments: { query: "hello", search_session_id: true },
    });

    expect(searchEvents).toHaveBeenCalledWith(
      "hello",
      null,
      10,
      DEFAULT_READABLE_SEARCH_EVENT_TYPES,
    );
    expect(searchEventsBySessionId).toHaveBeenCalledWith(
      "hello",
      DEFAULT_READABLE_SEARCH_EVENT_TYPES,
      10,
    );
    expect(result.structuredContent).toEqual({
      results: [
        {
          session_id: "sess-hello",
          event_id: 3,
          score: 0.5,
          preview: "readable session match",
          event_type: "user_message",
          match_source: "message",
          turn_count: 0,
          has_turn_summaries: false,
          has_story_digest: false,
          has_highlight: false,
        },
      ],
    });
  });

  it("adds turn summaries and digest fields only when explicitly requested", async () => {
    const searchEvents = vi.fn(async () => []);
    const searchSessionDigests = vi.fn(async () => []);
    const client = await createClient(makeRuntime({
      searchEvents,
      searchSessionDigests,
    }));

    await client.callTool({
      name: "search_session_history",
      arguments: {
        query: "needle",
        include_turn_summaries: true,
        include_highlight: true,
        include_story: true,
      },
    });

    expect(searchEvents.mock.calls[0]?.[3]).toContain("turn_summary");
    expect(searchSessionDigests).toHaveBeenCalledWith(
      "needle",
      null,
      10,
      true,
      true,
    );
  });

  it("attaches one consistent session metadata snapshot to every match", async () => {
    const searchEvents = vi.fn(async () => [
      {
        id: 11,
        session_id: "s1",
        event_type: "user_message",
        searchable_text: "needle one",
        score: 0.9,
      },
      {
        id: 12,
        session_id: "s1",
        event_type: "assistant_message",
        searchable_text: "needle two",
        score: 0.8,
      },
    ]);
    const getSessionSearchMetadata = vi.fn(async () => new Map([
      ["s1", {
        turnCount: 7,
        hasTurnSummaries: true,
        hasStoryDigest: false,
        hasHighlight: false,
      }],
    ]));
    const client = await createClient(makeRuntime({
      searchEvents,
      db: { getSessionSearchMetadata },
    }));

    const result = await client.callTool({
      name: "search_session_history",
      arguments: { query: "needle" },
    });

    expect(getSessionSearchMetadata).toHaveBeenCalledWith(["s1"]);
    expect(result.structuredContent?.results).toEqual([
      expect.objectContaining({
        session_id: "s1",
        turn_count: 7,
        has_turn_summaries: true,
        has_story_digest: false,
        has_highlight: false,
      }),
      expect.objectContaining({
        session_id: "s1",
        turn_count: 7,
        has_turn_summaries: true,
        has_story_digest: false,
        has_highlight: false,
      }),
    ]);
  });
});
