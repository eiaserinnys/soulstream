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
  on: (
    event: "message",
    handler: (data: string | Buffer | ArrayBuffer) => void,
  ) => void;
};

type WebSocketInjectableApp = {
  injectWS: (
    path: string,
    options: { headers: Record<string, string> },
  ) => Promise<TestWebSocket>;
};

describe("production create-session route", () => {
  it("generates one immutable agentSessionId before dispatching create_session", async () => {
    const sql = Object.assign(
      vi.fn(async () => []),
      { listen: vi.fn() },
    ) as unknown as LivePostgresSql;
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
    const authHeaders = {
      authorization: "Bearer production-service-token",
    };
    const ws = await (
      application.app as typeof application.app & WebSocketInjectableApp
    ).injectWS("/ws/node", { headers: authHeaders });

    try {
      ws.send(JSON.stringify({
        type: "node_register",
        node_id: "node-a",
        user: { email: "dashboard@example.com" },
      }));
      await waitForNode(application.app, authHeaders, "node-a");

      const commandPromise = waitForMessageType(ws, "create_session");
      const responsePromise = application.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: authHeaders,
        payload: {
          prompt: "hello from dashboard",
          agentId: "roselin_codex",
          folderId: "folder-a",
        },
      });
      const command = await commandPromise;
      const dispatchedSessionId = command.agentSessionId;
      ws.send(JSON.stringify({
        type: "session_created",
        requestId: command.requestId,
        agentSessionId:
          typeof dispatchedSessionId === "string"
            ? dispatchedSessionId
            : "legacy-node-generated-id",
      }));
      const response = await responsePromise;

      expect(dispatchedSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(command).toMatchObject({
        type: "create_session",
        prompt: "hello from dashboard",
        agentId: "roselin_codex",
        folderId: "folder-a",
        caller_info: { source: "browser" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        agentSessionId: dispatchedSessionId,
        nodeId: "node-a",
      });
    } finally {
      ws.terminate();
      await application.app.close();
      await application.closeResources();
    }
  });
});

async function waitForMessageType(
  ws: TestWebSocket,
  expectedType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      const decoded = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      ) as Record<string, unknown>;
      if (decoded.type === expectedType) resolve(decoded);
    });
  });
}

async function waitForNode(
  app: { inject: (options: Record<string, unknown>) => Promise<{ json: () => unknown }> },
  headers: Record<string, string>,
  nodeId: string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    const response = await app.inject({ method: "GET", url: "/api/nodes", headers });
    const body = response.json() as { nodes?: Array<{ nodeId?: string }> };
    if (body.nodes?.some((node) => node.nodeId === nodeId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Node registration timed out: ${nodeId}`);
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
