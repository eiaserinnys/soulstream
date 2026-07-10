import { describe, expect, it, vi } from "vitest";

import {
  createLiveProductionApplication,
  loadOrchServerEnvironment,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

type TestWebSocket = {
  send: (data: string) => void;
  terminate: () => void;
};

type SseFrame = {
  event: string;
  id?: string;
  data: Record<string, unknown>;
  raw: string;
};

describe("production live event fanout", () => {
  it("connects every production live-event consumer to its canonical source", async () => {
    const observedConsumers = new Set<string>();
    const database = createFakeSql();
    const sqlResolver: LiveDbSqlResolver = {
      resolveSql: vi.fn(async () => database.sql),
      close: vi.fn(async () => undefined),
    };
    const application = await createLiveProductionApplication(
      loadOrchServerEnvironment(minimalEnvironment()),
      { warn: vi.fn() },
      { sqlResolver },
    );
    await application.app.listen({ host: "127.0.0.1", port: 0 });
    await application.startBackground();
    const address = application.app.listeningOrigin;
    const realtimeController = new AbortController();
    const catalogController = new AbortController();
    const nodeController = new AbortController();
    const taskController = new AbortController();
    let ws: TestWebSocket | undefined;
    try {
      const authHeaders = { authorization: "Bearer production-service-token" };
      const nodeStream = await connectSse(
        `${address}/api/nodes/stream`,
        authHeaders,
        nodeController.signal,
      );
      const taskStream = await connectSse(
        `${address}/api/tasks/stream`,
        authHeaders,
        taskController.signal,
      );
      expect((await nodeStream.next("snapshot")).data).toEqual([]);
      expect((await taskStream.next("task_list")).data).toMatchObject({
        type: "task_list",
      });

      ws = await (application.app as typeof application.app & {
        injectWS: (
          path: string,
          options: { headers: Record<string, string> },
        ) => Promise<TestWebSocket>;
      }).injectWS("/ws/node", {
        headers: authHeaders,
      });
      ws.send(JSON.stringify({
        type: "node_register",
        node_id: "node-a",
        user: { email: "dashboard@example.com" },
      }));
      const nodeConnected = await nodeStream.next("node_connected");
      expect(nodeConnected.raw).toContain("event: node_connected\n");
      expect(nodeConnected.data).toMatchObject({
        nodeId: "node-a",
      });
      observedConsumers.add("node-stream");
      ws.send(JSON.stringify({
        type: "session_updated",
        agent_session_id: "session-a",
        status: "running",
        caller_source: "browser",
        session_type: "codex",
        last_event_id: 40,
      }));

      const realtime = await connectSse(
        `${address}/api/sessions/session-a/events`,
        authHeaders,
        realtimeController.signal,
      );
      const catalog = await connectSse(
        `${address}/api/sessions/stream`,
        authHeaders,
        catalogController.signal,
      );
      expect((await realtime.next("history_sync")).data).toMatchObject({
        type: "history_sync",
        is_live: true,
      });
      expect((await catalog.next("session_list")).data).toMatchObject({
        type: "session_list",
      });

      ws.send(JSON.stringify({
        type: "event",
        agentSessionId: "session-a",
        event: {
          _event_id: 41,
          type: "assistant_message",
          content: "live realtime message",
        },
      }));
      ws.send(JSON.stringify({
        type: "session_updated",
        agent_session_id: "session-a",
        status: "running",
        updated_at: "2026-07-10T12:00:00.000Z",
        last_event_id: 41,
        last_read_event_id: 40,
        last_message: {
          type: "assistant_message",
          preview: "live catalog message",
          timestamp: "2026-07-10T12:00:00.000Z",
        },
      }));

      expect((await realtime.next("assistant_message", 1_000)).data).toMatchObject({
        type: "assistant_message",
        content: "live realtime message",
      });
      observedConsumers.add("per-session-realtime");
      const catalogUpdated = await catalog.next("session_updated", 1_000);
      expect(catalogUpdated.raw).toContain("event: session_updated\n");
      expect(catalogUpdated.raw).toContain("\ndata: {\"type\":\"session_updated\"");
      // F-3A/G-19: the node message-update wire has exactly seven keys. The
      // orchestrator must forward that variant without requiring state-update
      // metadata such as caller_source or session_type; only nodeId is added.
      expect(Object.keys(catalogUpdated.data).sort()).toEqual([
        "agent_session_id",
        "last_event_id",
        "last_message",
        "last_read_event_id",
        "nodeId",
        "status",
        "type",
        "updated_at",
      ].sort());
      expect(catalogUpdated.data).toMatchObject({
        type: "session_updated",
        agent_session_id: "session-a",
        status: "running",
        updated_at: "2026-07-10T12:00:00.000Z",
        last_event_id: 41,
        last_read_event_id: 40,
        last_message: {
          type: "assistant_message",
          preview: "live catalog message",
          timestamp: "2026-07-10T12:00:00.000Z",
        },
      });
      expect(catalogUpdated.data).not.toHaveProperty("caller_source");
      expect(catalogUpdated.data).not.toHaveProperty("session_type");
      observedConsumers.add("sessions-stream");

      database.publishTaskChange({ taskId: "task-a", operation: "updated" });
      const taskChanged = await taskStream.next("task_changed");
      expect(taskChanged.raw).toContain("event: task_changed\n");
      expect(taskChanged.data).toMatchObject({
        type: "task_changed",
        change: {
          taskId: "task-a",
          operation: "updated",
        },
      });
      observedConsumers.add("tasks-stream");

      ws.send(JSON.stringify({
        type: "session_updated",
        agent_session_id: "session-a",
        status: "completed",
        caller_source: "browser",
        session_type: "codex",
        last_event_id: 42,
        last_message: { preview: "completed" },
      }));
      await waitForCondition(() =>
        database.queries.some((query) => query.includes("supervisor_event_append")) &&
        database.queries.some((query) => query.includes("FROM push_tokens"))
      );
      observedConsumers.add("supervisor-ingest");
      observedConsumers.add("push-notifier");
      expect([...observedConsumers].sort()).toEqual([
        "node-stream",
        "per-session-realtime",
        "push-notifier",
        "sessions-stream",
        "supervisor-ingest",
        "tasks-stream",
      ]);
    } finally {
      realtimeController.abort();
      catalogController.abort();
      nodeController.abort();
      taskController.abort();
      ws?.terminate();
      await application.app.close();
      await application.closeResources();
    }
  });
});

function createFakeSql(): {
  sql: LivePostgresSql;
  queries: string[];
  publishTaskChange: (change: Record<string, unknown>) => void;
} {
  const queries: string[] = [];
  let taskChangeListener: ((payload: string) => void) | undefined;
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    queries.push(text.replace(/\s+/g, " ").trim());
    if (text.includes("session_count")) return [{ count: 0 }];
    if (text.includes("MAX(id)")) return [{ last_event_id: 40 }];
    if (text.includes("supervisor_event_append")) {
      return [{
        offset: 1,
        inserted: true,
        contiguous_upto: 42,
        highest_seen_event_id: 42,
        gap_start: null,
        gap_end: null,
      }];
    }
    return [];
  });
  const sql = Object.assign(query, {
    listen: vi.fn(async (_channel: string, listener: (payload: string) => void) => {
      taskChangeListener = listener;
      return {
        unlisten: vi.fn(async () => {
          taskChangeListener = undefined;
        }),
      };
    }),
  }) as unknown as LivePostgresSql;
  return {
    sql,
    queries,
    publishTaskChange(change) {
      if (taskChangeListener === undefined) {
        throw new Error("Task change listener is not running");
      }
      taskChangeListener(JSON.stringify(change));
    },
  };
}

async function connectSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ next: (event: string, timeoutMs?: number) => Promise<SseFrame> }> {
  const response = await fetch(url, { headers, signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE response body is missing");
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next(event, timeoutMs = 2_000) {
      return withTimeout((async () => {
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary >= 0) {
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseSseFrame(rawFrame);
            if (frame?.event === event) return frame;
            continue;
          }
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`SSE stream ended before ${event}`);
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      })(), timeoutMs, `Timed out waiting for SSE event ${event}`);
    },
  };
}

function parseSseFrame(rawFrame: string): SseFrame | undefined {
  const values = new Map<string, string>();
  for (const line of rawFrame.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
  }
  const event = values.get("event");
  const data = values.get("data");
  if (event === undefined || data === undefined) return undefined;
  return {
    event,
    ...(values.has("id") ? { id: values.get("id") } : {}),
    data: JSON.parse(data) as Record<string, unknown>,
    raw: rawFrame,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for production event consumers");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function minimalEnvironment(): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://unused@localhost/unused",
    ENVIRONMENT: "production",
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1",
    AUTH_BEARER_TOKEN: "production-service-token",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
