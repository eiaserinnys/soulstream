import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  createApp,
  parseOrchServerConfig,
} from "../src/index.js";

const productionConfig = parseOrchServerConfig({
  environment: "production",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "production-service-token",
});

const testConfig = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type TestWebSocket = {
  terminate: () => void;
};

type WebSocketInjectableApp = {
  injectWS: (
    path: string,
    upgradeContext?: { headers?: Record<string, string> },
  ) => Promise<TestWebSocket>;
};

describe("production operations logging", () => {
  it("records access, authentication, and 5xx diagnostics while redacting secrets", async () => {
    const capture = createLogCapture();
    const resolveTokenAccess = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        statusCode: 401,
        detail: "Authorization header required",
      })
      .mockResolvedValueOnce({
        ok: false as const,
        statusCode: 403,
        detail: "Authentication forbidden",
      });
    const app = createApp({
      config: productionConfig,
      logDestination: capture.stream,
      productionAuth: {
        resolveTokenAccess,
      },
      publicStatusRoutes: createPublicStatusRouteOptions(),
    });
    app.get("/logging/ok", async (request) => {
      request.log.info({
        headers: request.headers,
        token: "route-token-secret",
      }, "sensitive logging probe");
      return { ok: true };
    });
    app.get("/logging/fail", async () => {
      throw new Error("diagnostic-stack-marker");
    });

    const ok = await app.inject({
      method: "GET",
      url: "/logging/ok",
      headers: {
        authorization: "Bearer authorization-secret",
        cookie: "session=cookie-secret",
      },
    });
    const unauthorized = await app.inject({ method: "GET", url: "/api/status" });
    const forbidden = await app.inject({ method: "GET", url: "/api/status" });
    const failed = await app.inject({ method: "GET", url: "/logging/fail" });
    await app.close();

    expect(ok.statusCode).toBe(200);
    expect(unauthorized.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(failed.statusCode).toBe(500);

    const records = capture.records();
    expect(records).toContainEqual(expect.objectContaining({
      msg: "HTTP request completed",
      method: "GET",
      path: "/logging/ok",
      statusCode: 200,
      durationMs: expect.any(Number),
    }));
    expect(records).toContainEqual(expect.objectContaining({
      msg: "HTTP authentication rejected",
      method: "GET",
      path: "/api/status",
      statusCode: 401,
    }));
    expect(records).toContainEqual(expect.objectContaining({
      msg: "HTTP authentication rejected",
      method: "GET",
      path: "/api/status",
      statusCode: 403,
    }));
    expect(records).toContainEqual(expect.objectContaining({
      msg: "HTTP request failed",
      method: "GET",
      path: "/logging/fail",
      statusCode: 500,
      err: expect.objectContaining({
        message: "diagnostic-stack-marker",
        stack: expect.stringContaining("diagnostic-stack-marker"),
      }),
    }));

    const raw = capture.raw();
    expect(raw).toContain("[Redacted]");
    expect(raw).not.toContain("authorization-secret");
    expect(raw).not.toContain("cookie-secret");
    expect(raw).not.toContain("route-token-secret");
  });

  it("keeps development and test request logging silent", async () => {
    const capture = createLogCapture();
    const app = createApp({
      config: testConfig,
      logDestination: capture.stream,
    });
    app.get("/silent", async (request) => {
      request.log.info("should stay silent");
      return { ok: true };
    });

    expect((await app.inject({ method: "GET", url: "/silent" })).statusCode).toBe(200);
    await app.close();

    expect(capture.raw()).toBe("");
  });

  it("records node WebSocket connection and disconnection events", async () => {
    const capture = createLogCapture();
    const app = createApp({
      config: productionConfig,
      logDestination: capture.stream,
      nodeWsRoute: { registry: new InMemoryNodeRegistry() },
    });

    await app.ready();
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
      { headers: { authorization: "Bearer production-service-token" } },
    );
    await waitFor(
      () => capture.records().some(
        (record) => record.msg === "Node WebSocket connected",
      ),
      () => capture.raw(),
    );

    ws.terminate();
    await waitFor(() => capture.records().some(
      (record) => record.msg === "Node WebSocket disconnected",
    ));
    await app.close();

    expect(capture.records()).toContainEqual(expect.objectContaining({
      msg: "Node WebSocket disconnected",
      reason: "websocket_close",
    }));
  });
});

function createPublicStatusRouteOptions() {
  return {
    configProvider: {
      getConfig: () => ({
        authEnabled: true,
        atomEnabled: false,
      }),
    },
    folderCountsProvider: {
      getFolderCounts: () => new Map<string | null, number>(),
      listFolders: () => [],
      resolveAccess: () => ({ restricted: false }),
    },
  };
}

function createLogCapture() {
  const chunks: string[] = [];
  return {
    stream: {
      write(message: string) {
        chunks.push(message);
      },
    },
    raw: () => chunks.join(""),
    records: (): Array<Record<string, unknown>> => chunks.join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function waitFor(
  predicate: () => boolean,
  diagnostic: () => string = () => "",
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for condition: ${diagnostic()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
