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
  data: Record<string, unknown>;
};

const SESSION_ID = "90484ea9-339e-4103-bc33-c2a0faa7ffff";
const CLIENT_SESSION_FIELDS = {
  agentSessionId: SESSION_ID,
  displayName: "🔷 오케스트레이터 TS화 컷오버 게이트",
  nodeId: "node-a",
  agentId: "seosoyoung",
  agentName: "서소영",
  agentPortraitUrl: "/api/nodes/node-a/agents/seosoyoung/portrait",
  backend: "codex",
  userName: "서소영",
  userPortraitUrl: "/api/nodes/node-a/user/portrait",
} as const;

describe("production session serialization parity", () => {
  it("uses the Python client wire for REST, session_list, and session_updated", async () => {
    const row = sessionRow();
    const database = createFakeSql(row);
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
      ws.send(JSON.stringify({
        type: "node_register",
        node_id: "node-a",
        agents: [{
          id: "seosoyoung",
          name: "서소영",
          backend: "codex",
          portrait_url: "/api/agents/seosoyoung/portrait",
        }],
        user: { name: "서소영", hasPortrait: true },
      }));
      ws.send(JSON.stringify({
        type: "sessions_update",
        sessions: [{
          ...row,
          displayName: null,
          agentId: null,
        }],
        total: 1,
        requestId: "",
      }));

      const restSession = await waitForRestSession(
        application.app,
        authHeaders,
        SESSION_ID,
        CLIENT_SESSION_FIELDS,
      );
      expect(restSession).toMatchObject(CLIENT_SESSION_FIELDS);

      const catalog = await connectSse(
        `${application.app.listeningOrigin}/api/sessions/stream`,
        authHeaders,
        catalogController.signal,
      );
      const sessionList = await catalog.next("session_list");
      expect(sessionList.data.sessions).toEqual([
        expect.objectContaining(CLIENT_SESSION_FIELDS),
      ]);

      ws.send(JSON.stringify({
        type: "session_updated",
        agent_session_id: SESSION_ID,
        status: "running",
        updated_at: "2026-07-10T14:20:00.000Z",
        last_event_id: 42,
        last_read_event_id: 41,
      }));
      expect((await catalog.next("session_updated")).data).toMatchObject(
        CLIENT_SESSION_FIELDS,
      );
    } finally {
      catalogController.abort();
      ws?.terminate();
      await application.app.close();
      await application.closeResources();
    }
  });
});

function sessionRow(): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    status: "running",
    prompt: "컷오버 게이트를 검증한다",
    created_at: "2026-07-10T13:00:00.000Z",
    updated_at: "2026-07-10T14:00:00.000Z",
    session_type: "codex",
    last_message: null,
    client_id: null,
    metadata: {},
    display_name: "🔷 오케스트레이터 TS화 컷오버 게이트",
    node_id: "node-a",
    folder_id: "folder-a",
    last_event_id: 41,
    last_read_event_id: 41,
    caller_session_id: null,
    agent_id: "seosoyoung",
  };
}

function createFakeSql(row: Record<string, unknown>): { sql: LivePostgresSql } {
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("session_count")) return [{ count: 1 }];
    if (text.includes("session_get_all")) return [row];
    return [];
  });
  return {
    sql: Object.assign(query, {
      json: (value: unknown) => value,
      listen: vi.fn(async () => ({ unlisten: vi.fn(async () => undefined) })),
    }) as unknown as LivePostgresSql,
  };
}

async function waitForRestSession(
  app: { inject: (options: Record<string, unknown>) => Promise<{ json: () => unknown }> },
  headers: Record<string, string>,
  sessionId: string,
  expectedFields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const body = (await app.inject({
      method: "GET",
      url: "/api/sessions",
      headers,
    })).json() as { sessions?: Record<string, unknown>[] };
    const session = body.sessions?.find(
      (candidate) => candidate.agentSessionId === sessionId,
    );
    if (session !== undefined && matchesFields(session, expectedFields)) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`REST session did not appear: ${sessionId}`);
}

function matchesFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

async function connectSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ next: (event: string) => Promise<SseFrame> }> {
  const response = await fetch(url, { headers, signal });
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
          if (parsed?.event === event) return { data: parsed.data };
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`SSE stream ended before ${event}`);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

function parseSseFrame(raw: string): { event: string; data: Record<string, unknown> } | undefined {
  const event = raw.match(/^event: (.+)$/m)?.[1];
  const data = raw.match(/^data: (.+)$/m)?.[1];
  return event === undefined || data === undefined
    ? undefined
    : { event, data: JSON.parse(data) as Record<string, unknown> };
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
