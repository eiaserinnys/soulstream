import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  createApp,
  loadContractFixtures,
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
  close: (code: number, reason: string) => void;
  send: (data: string) => void;
  on: (event: "message", handler: () => void) => void;
};

type WebSocketInjectableApp = {
  injectWS: (
    path: string,
    upgradeContext?: { headers?: Record<string, string> },
  ) => Promise<TestWebSocket>;
};

describe("production operations logging", () => {
  it("records the node header and prefers an authenticated node principal", async () => {
    const capture = createLogCapture();
    const app = createApp({
      config: productionConfig,
      logDestination: capture.stream,
      productionAuth: {
        resolveTokenAccess: async () => ({ ok: true as const }),
        nodeCredentials: {
          resolve: (token) => token === "node-token" ? { credential_id: "cred", node_id: "authenticated-node", company_pc: false } : null,
          onRevoked: () => () => {},
        },
      },
    });
    app.post("/api/schedules/host/:operation", async (_request, reply) => reply.code(409).send({ ok: false }));
    for (const authorization of ["Bearer production-service-token", "Bearer node-token"]) {
      expect((await app.inject({ method: "POST", url: "/api/schedules/host/test", headers: { authorization, "x-soulstream-node-id": "header-node" } })).statusCode).toBe(409);
    }
    await app.close();
    const completed = capture.records().filter((record) => record.msg === "HTTP request completed");
    expect(completed.map((record) => record.nodeId)).toEqual(["header-node", "authenticated-node"]);
  });
  it("keeps a fast successful host request out of the info log but records a failed one", async () => {
    const capture = createLogCapture();
    const app = createApp({
      config: productionConfig,
      logDestination: capture.stream,
      productionAuth: { resolveTokenAccess: async () => ({ ok: true as const }) },
    });
    app.post("/api/schedules/host/ok", async () => ({ ok: true }));
    app.post("/api/schedules/host/conflict", async (_request, reply) => reply.code(409).send({ ok: false }));
    const headers = { authorization: "Bearer production-service-token" };
    await app.inject({ method: "POST", url: "/api/schedules/host/ok", headers });
    await app.inject({ method: "POST", url: "/api/schedules/host/conflict", headers });
    await app.close();

    const completed = capture.records().filter((record) => record.msg === "HTTP request completed");
    expect(completed.map((record) => [record.path, record.statusCode])).toEqual([
      ["/api/schedules/host/conflict", 409],
    ]);
  });

  it("records access, authentication, and 5xx diagnostics while redacting secrets", async () => {
    const capture = createLogCapture();
    const resolveTokenAccess = vi.fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({
        ok: false as const,
        statusCode: 401,
        detail: "Authorization header required",
      })
      .mockResolvedValueOnce({
        ok: false as const,
        statusCode: 403,
        detail: "Authentication forbidden",
      })
      .mockResolvedValueOnce({ ok: true as const });
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
        MCP_EXTERNAL_INGRESS_BEARER_TOKEN: "external-ingress-log-probe",
        config: { mcp_external_ingress_bearer_token: "external-config-log-probe" },
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
    expect(raw).not.toContain("external-ingress-log-probe");
    expect(raw).not.toContain("external-config-log-probe");
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

  it("records registered identity and handover close on both WebSocket lanes", async () => {
    const capture = createLogCapture();
    const registry = new InMemoryNodeRegistry();
    const app = createApp({ config: productionConfig, logDestination: capture.stream,
      nodeWsRoute: { nodeCredentials: {
        resolve: (token) => token === "node-token" ? { credential_id: "cred", node_id: "fake-node", company_pc: false } : null,
        onRevoked: () => () => {},
      }, registry } });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const headers = { authorization: "Bearer node-token" };
    const connect = async (path: string): Promise<WebSocket> => {
      const socket = new WebSocket(address.replace("http:", "ws:") + path, { headers });
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      return socket;
    };
    const data = await connect("/ws/node");
    const registered = new Promise<void>((resolve) => data.once("message", () => resolve()));
    const registration = loadContractFixtures().fakeNodeReconnect.registration as Record<string, unknown>;
    data.send(JSON.stringify({ ...registration, capabilities: { ...(registration.capabilities as Record<string, unknown> | undefined), control_channel_v1: true } }));
    await registered;
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const connectionId = registry.getConnectedNode("fake-node")!.connectionId;
    const control = await connect("/ws/node/control");
    const controlRegistered = new Promise<void>((resolve) => control.once("message", () => resolve()));
    control.send(JSON.stringify({ type: "node_control_register", node_id: "fake-node", connection_id: connectionId }));
    await controlRegistered;
    control.close(1012, "orchestrator_handover");
    await waitFor(() => capture.records().some((r) => r.msg === "Node control WebSocket disconnected"));
    data.close(1012, "orchestrator_handover");
    await waitFor(() => capture.records().some((r) => r.msg === "Node WebSocket disconnected"), () => capture.raw());
    await app.close();
    const records = capture.records();
    expect(records).toContainEqual(expect.objectContaining({ msg: "Node WebSocket connected", nodeId: "fake-node" }));
    expect(records).toContainEqual(expect.objectContaining({ msg: "Node WebSocket registered", nodeId: "fake-node", connectionId }));
    for (const msg of ["Node WebSocket disconnected", "Node control WebSocket disconnected"]) {
      expect(records).toContainEqual(expect.objectContaining({ msg, reason: "websocket_close", nodeId: "fake-node", connectionId, closeCode: 1012, closeReason: "orchestrator_handover" }));
    }
  });

  it("records node WebSocket connection and disconnection events", async () => {
    const capture = createLogCapture();
    const app = createApp({
      config: productionConfig,
      logDestination: capture.stream,
      nodeWsRoute: { nodeCredentials: null, registry: new InMemoryNodeRegistry() },
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
