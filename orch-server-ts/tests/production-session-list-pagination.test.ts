import { describe, expect, it, vi } from "vitest";

import {
  createLiveProductionApplication,
  loadOrchServerEnvironment,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

type SqlCall = {
  text: string;
  values: unknown[];
};

type SseFrame = {
  event: string;
  data: Record<string, unknown>;
};

describe("production session list pagination parity", () => {
  it("treats feed_only limit=0 as an unbounded DB snapshot", async () => {
    const harness = await createProductionHarness();
    try {
      const response = await harness.application.app.inject({
        method: "GET",
        url: "/api/sessions?feed_only=true&limit=0",
        headers: harness.authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        sessions: [
          expect.objectContaining({ agentSessionId: "session-3" }),
          expect.objectContaining({ agentSessionId: "session-2" }),
          expect.objectContaining({ agentSessionId: "session-1" }),
        ],
        total: 3,
        cursor: null,
        nextCursor: null,
        hasMore: false,
      });
      expect(sessionListCalls(harness.calls)).toEqual([
        {
          filters: { feed_only: true },
          limit: null,
          offset: null,
        },
      ]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("keeps Python-compatible positive-limit cursor pagination", async () => {
    const harness = await createProductionHarness();
    try {
      const first = await harness.application.app.inject({
        method: "GET",
        url: "/api/sessions?limit=2",
        headers: harness.authHeaders,
      });
      expect(first.json()).toMatchObject({
        sessions: [
          expect.objectContaining({ agentSessionId: "session-3" }),
          expect.objectContaining({ agentSessionId: "session-2" }),
        ],
        total: 3,
        cursor: "2",
        nextCursor: "2",
        hasMore: true,
      });

      const second = await harness.application.app.inject({
        method: "GET",
        url: "/api/sessions?cursor=2&limit=2",
        headers: harness.authHeaders,
      });
      expect(second.json()).toMatchObject({
        sessions: [expect.objectContaining({ agentSessionId: "session-1" })],
        total: 3,
        cursor: null,
        nextCursor: null,
        hasMore: false,
      });
      expect(sessionListCalls(harness.calls)).toEqual([
        { filters: {}, limit: 2, offset: null },
        { filters: {}, limit: 2, offset: 2 },
      ]);
    } finally {
      await closeHarness(harness);
    }
  });

  it("keeps SSE feed_only on the DB path with Python's 200-row snapshot cap", async () => {
    const harness = await createProductionHarness();
    const controller = new AbortController();
    try {
      await harness.application.app.listen({ host: "127.0.0.1", port: 0 });
      const stream = await connectSse(
        `${harness.application.app.listeningOrigin}/api/sessions/stream?feed_only=true&limit=0`,
        harness.authHeaders,
        controller.signal,
      );

      expect((await stream.next("session_list")).data).toMatchObject({
        type: "session_list",
        total: 3,
      });
      expect(sessionListCalls(harness.calls)).toEqual([
        {
          filters: { feed_only: true },
          limit: 200,
          offset: null,
        },
      ]);
    } finally {
      controller.abort();
      await closeHarness(harness);
    }
  });
});

async function createProductionHarness() {
  const calls: SqlCall[] = [];
  const rows = [sessionRow("session-3"), sessionRow("session-2"), sessionRow("session-1")];
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (text.includes("session_count")) return [{ count: rows.length }];
    if (text.includes("session_get_all")) {
      const limit = typeof values[1] === "number" ? values[1] : undefined;
      const offset = typeof values[2] === "number" ? values[2] : 0;
      return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
    }
    return [];
  });
  const sql = Object.assign(query, {
    listen: vi.fn(async () => ({ unlisten: vi.fn(async () => undefined) })),
  }) as unknown as LivePostgresSql;
  const sqlResolver: LiveDbSqlResolver = {
    resolveSql: vi.fn(async () => sql),
    close: vi.fn(async () => undefined),
  };
  const application = await createLiveProductionApplication(
    loadOrchServerEnvironment(minimalEnvironment()),
    { warn: vi.fn() },
    { sqlResolver },
  );
  await application.app.ready();
  return {
    application,
    calls,
    authHeaders: { authorization: "Bearer production-service-token" },
  };
}

function sessionRow(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    status: "running",
    prompt: sessionId,
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T11:00:00.000Z",
    session_type: "codex",
    metadata: {},
    display_name: sessionId,
    node_id: "node-a",
    folder_id: "feed-folder",
    last_event_id: 1,
    last_read_event_id: 0,
    agent_id: "seosoyoung",
  };
}

function sessionListCalls(calls: SqlCall[]): Array<{
  filters: Record<string, unknown>;
  limit: unknown;
  offset: unknown;
}> {
  return calls
    .filter((call) => call.text.includes("session_get_all"))
    .map((call) => ({
      filters: JSON.parse(String(call.values[0])) as Record<string, unknown>,
      limit: call.values[1],
      offset: call.values[2],
    }));
}

async function connectSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ next: (event: string) => Promise<SseFrame> }> {
  const response = await fetch(url, { headers, signal });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE response body is missing");
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(event) {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseFrame(raw);
          if (parsed?.event === event) return parsed;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`SSE stream ended before ${event}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

function parseSseFrame(raw: string): SseFrame | undefined {
  const event = raw.match(/^event: (.+)$/m)?.[1];
  const data = raw.match(/^data: (.+)$/m)?.[1];
  return event === undefined || data === undefined
    ? undefined
    : { event, data: JSON.parse(data) as Record<string, unknown> };
}

async function closeHarness(
  harness: Awaited<ReturnType<typeof createProductionHarness>>,
): Promise<void> {
  await harness.application.app.close();
  await harness.application.closeResources();
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
