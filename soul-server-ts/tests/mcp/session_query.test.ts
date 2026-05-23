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
  "assistant_message",
  "user_text",
  "assistant_text",
  "text_delta",
  "result",
  "complete",
  "error",
  "away_summary",
  "intervention_sent",
  "realtime_transcript",
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
}): McpRuntime {
  return {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: {
      searchEvents: params.searchEvents ?? vi.fn(async () => []),
      searchEventsBySessionId: params.searchEventsBySessionId ?? vi.fn(async () => []),
    } as unknown as SessionDB,
    taskManager: {} as TaskManager,
    taskExecutor: {} as TaskExecutor,
    agentRegistry: {} as McpRuntime["agentRegistry"],
    catalogService: {} as CatalogService,
    logger: createSilentLogger(),
  };
}

async function createClient(runtime: McpRuntime): Promise<Client> {
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
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
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

describe("search_session_history", () => {
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
