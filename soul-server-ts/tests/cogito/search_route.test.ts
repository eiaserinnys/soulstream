import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildServer, type ServerInstance } from "../../src/server.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

const openServers: ServerInstance[] = [];

function createSilentLogger() {
  const noop = () => undefined;
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
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
    catalogService: {} as McpRuntime["catalogService"],
    logger: createSilentLogger(),
  };
}

async function createServer(runtime: McpRuntime): Promise<ServerInstance> {
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: runtime.nodeId,
    logger: createSilentLogger(),
    cogito: { runtime },
  });
  openServers.push(server);
  return server;
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.close();
  }
});

describe("GET /cogito/search", () => {
  it("returns dashboard search results through the same DB path as MCP search", async () => {
    const searchEvents = vi.fn(async () => [
      {
        id: 828,
        session_id: "4cbdd6b7-490a-4aeb-bb76-0568d0dc0cdd",
        event_type: "text_delta",
        searchable_text: "가라앉은 배\n한복...",
        score: 10.09,
      },
    ]);
    const runtime = makeRuntime({ searchEvents });
    const server = await createServer(runtime);

    const response = await server.inject({
      method: "GET",
      url: "/cogito/search?q=%EA%B0%80%EB%9D%BC%EC%95%89%EC%9D%80&top_k=5",
    });

    expect(response.statusCode).toBe(200);
    expect(searchEvents).toHaveBeenCalledWith(
      "가라앉은",
      null,
      5,
      [
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
      ],
    );
    expect(response.json()).toEqual({
      results: [
        {
          session_id: "4cbdd6b7-490a-4aeb-bb76-0568d0dc0cdd",
          event_id: 828,
          score: 10.09,
          preview: "가라앉은 배\n한복...",
          event_type: "text_delta",
        },
      ],
    });
  });

  it("honors event type filters and session id fallback", async () => {
    const searchEvents = vi.fn(async () => []);
    const searchEventsBySessionId = vi.fn(async () => [
      {
        id: 7,
        session_id: "sess-special",
        event_type: "user_message",
        searchable_text: "session id fallback result",
        score: 0.5,
      },
    ]);
    const runtime = makeRuntime({ searchEvents, searchEventsBySessionId });
    const server = await createServer(runtime);

    const response = await server.inject({
      method: "GET",
      url: "/cogito/search?q=special&event_types=user_message&search_session_id=true&top_k=3",
    });

    expect(response.statusCode).toBe(200);
    expect(searchEvents).toHaveBeenCalledWith("special", null, 3, ["user_message"]);
    expect(searchEventsBySessionId).toHaveBeenCalledWith("special", ["user_message"], 3);
    expect(response.json().results).toHaveLength(1);
  });
});
