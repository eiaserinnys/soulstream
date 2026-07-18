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
  it("forwards last-message updates for sessions restored from a node dump", async () => {
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
    const catalogController = new AbortController();
    let ws: TestWebSocket | undefined;
    try {
      const authHeaders = { authorization: "Bearer production-service-token" };
      ws = await (application.app as typeof application.app & {
        injectWS: (
          path: string,
          options: { headers: Record<string, string> },
        ) => Promise<TestWebSocket>;
      }).injectWS("/ws/node", { headers: authHeaders });
      ws.send(JSON.stringify({ type: "node_register", node_id: "node-a" }));
      ws.send(JSON.stringify({
        type: "sessions_update",
        sessions: [{
          agentSessionId: "restored-session",
          status: "running",
          last_event_id: 40,
        }],
        total: 1,
        requestId: "",
      }));

      // Production restart order: the node reconnects and sends its dump before
      // dashboard clients reopen the catalog stream.
      const catalog = await connectSse(
        `${application.app.listeningOrigin}/api/sessions/stream`,
        authHeaders,
        catalogController.signal,
      );
      expect((await catalog.next("session_list")).data).toMatchObject({
        type: "session_list",
      });
      ws.send(JSON.stringify({
        type: "session_updated",
        agent_session_id: "restored-session",
        status: "running",
        updated_at: "2026-07-10T12:50:00.000Z",
        last_message: {
          type: "assistant_message",
          preview: "restored session live message",
          timestamp: "2026-07-10T12:50:00.000Z",
        },
        last_event_id: 41,
        last_read_event_id: 40,
      }));

      expect((await catalog.next("session_updated", 1_000)).data).toMatchObject({
        agent_session_id: "restored-session",
        last_message: {
          type: "assistant_message",
          preview: "restored session live message",
        },
      });
    } finally {
      catalogController.abort();
      ws?.terminate();
      await application.app.close();
      await application.closeResources();
    }
  });

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
    let ws: TestWebSocket | undefined;
    try {
      const authHeaders = { authorization: "Bearer production-service-token" };
      const nodeStream = await connectSse(
        `${address}/api/nodes/stream`,
        authHeaders,
        nodeController.signal,
      );
      expect((await nodeStream.next("snapshot")).data).toEqual([]);

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
      // The node message-update wire stays sparse, while the orchestrator adds
      // the canonical client session fields from its updated registry cache.
      expect(Object.keys(catalogUpdated.data)).toEqual(expect.arrayContaining([
        "agent_session_id",
        "agentSessionId",
        "displayName",
        "agentId",
        "agentName",
        "agentPortraitUrl",
        "backend",
        "userName",
        "userPortraitUrl",
        "last_event_id",
        "last_message",
        "last_read_event_id",
        "nodeId",
        "status",
        "type",
        "updated_at",
      ]));
      expect(catalogUpdated.data).toMatchObject({
        type: "session_updated",
        agent_session_id: "session-a",
        agentSessionId: "session-a",
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
      ]);
    } finally {
      realtimeController.abort();
      catalogController.abort();
      nodeController.abort();
      ws?.terminate();
      await application.app.close();
      await application.closeResources();
    }
  });
});

function createFakeSql(): {
  sql: LivePostgresSql;
  queries: string[];
} {
  const queries: string[] = [];
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
    json: vi.fn((value: unknown) => ({ jsonValue: value })),
  }) as unknown as LivePostgresSql;
  return {
    sql,
    queries,
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
    BOARD_YJS_HOST_MODE: "orch",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
