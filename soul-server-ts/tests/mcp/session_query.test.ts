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
  db?: Record<string, unknown>;
  childCompletionConsumption?: McpRuntime["childCompletionConsumption"];
}): McpRuntime {
  return {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {
      searchEvents: params.searchEvents ?? vi.fn(async () => []),
      searchEventsBySessionId: params.searchEventsBySessionId ?? vi.fn(async () => []),
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
        countEvents: vi.fn(async () => 0),
        readEvents: vi.fn(async () => []),
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
  it("returns separated highlight and narrative with unfolded summaries in wire shape", async () => {
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
      highlight: "핵심 다섯 문장.",
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

  it("preserves the no-digest fallback without inventing narrative fields", async () => {
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
      highlight: null,
      narrative: null,
      narrative_through_event_id: null,
      fold_count: 0,
      updated_at: null,
      unfolded_turn_summaries: [{ event_id: 8, turn_number: 1 }],
    });
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
        },
      ],
    });
  });
});
