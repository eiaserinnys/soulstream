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
  it("returns only feed-eligible sessions for feed_only limit=0", async () => {
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
          expect.objectContaining({ agentSessionId: "normal-session" }),
        ],
        total: 1,
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
          expect.objectContaining({ agentSessionId: "normal-session" }),
          expect.objectContaining({ agentSessionId: "llm-session" }),
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
        sessions: [
          expect.objectContaining({ agentSessionId: "excluded-folder-session" }),
        ],
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

  it("loads only explicitly requested session summaries without scanning the catalog", async () => {
    const harness = await createProductionHarness();
    try {
      const response = await harness.application.app.inject({
        method: "GET",
        url: "/api/sessions?session_id=excluded-folder-session&session_id=normal-session&limit=0",
        headers: harness.authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        sessions: [
          expect.objectContaining({ agentSessionId: "normal-session" }),
          expect.objectContaining({ agentSessionId: "excluded-folder-session" }),
        ],
        total: 2,
        hasMore: false,
      });
      expect(sessionListCalls(harness.calls)).toEqual([]);
      expect(targetedSessionListCalls(harness.calls)).toEqual([
        ["excluded-folder-session", "normal-session"],
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
        sessions: [
          expect.objectContaining({ agentSessionId: "normal-session" }),
        ],
        total: 1,
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
  const folders = new Map([
    ["feed-folder", { excludeFromFeed: false }],
    ["excluded-folder", { excludeFromFeed: true }],
  ]);
  const rows = [
    sessionRow("normal-session", "feed-folder", "claude"),
    sessionRow("llm-session", "feed-folder", "llm"),
    sessionRow("excluded-folder-session", "excluded-folder", "claude"),
  ];
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (text.includes("FROM sessions s") && text.includes("s.session_id = ANY")) {
      const sessionIds = Array.isArray(values[0]) ? values[0] : [];
      return rows.filter((row) => sessionIds.includes(row.session_id));
    }
    const filters = databaseJsonbObject(values[0]);
    const filteredRows = filters.feed_only === true
      ? rows.filter((row) =>
          row.session_type !== "llm" &&
          folders.get(String(row.folder_id))?.excludeFromFeed !== true
        )
      : rows;
    if (text.includes("session_count")) return [{ count: filteredRows.length }];
    if (text.includes("session_get_all")) {
      const limit = typeof values[1] === "number" ? values[1] : undefined;
      const offset = typeof values[2] === "number" ? values[2] : 0;
      return limit === undefined
        ? filteredRows.slice(offset)
        : filteredRows.slice(offset, offset + limit);
    }
    return [];
  });
  const sql = Object.assign(query, {
    json: vi.fn((value: unknown) => ({ jsonValue: value })),
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

function targetedSessionListCalls(calls: SqlCall[]): unknown[][] {
  return calls
    .filter((call) =>
      call.text.includes("FROM sessions s") &&
      call.text.includes("s.session_id = ANY")
    )
    .map((call) => Array.isArray(call.values[0]) ? call.values[0] : []);
}

function sessionRow(
  sessionId: string,
  folderId: string,
  sessionType: string,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    status: "running",
    prompt: sessionId,
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-10T11:00:00.000Z",
    session_type: sessionType,
    metadata: {},
    display_name: sessionId,
    node_id: "node-a",
    folder_id: folderId,
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
      filters: intendedJsonbObject(call.values[0]),
      limit: call.values[1],
      offset: call.values[2],
    }));
}

function databaseJsonbObject(value: unknown): Record<string, unknown> {
  // postgres.js encodes a plain JavaScript string as a JSON string scalar.
  // Only sql.json(...) produces the object-shaped JSONB parameter this DB contract needs.
  if (
    typeof value === "object" &&
    value !== null &&
    "jsonValue" in value &&
    typeof value.jsonValue === "object" &&
    value.jsonValue !== null
  ) {
    return value.jsonValue as Record<string, unknown>;
  }
  return {};
}

function intendedJsonbObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return databaseJsonbObject(value);
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
    BOARD_YJS_HOST_MODE: "orch",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
