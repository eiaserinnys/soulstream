import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type NodeRegistryEvent,
} from "../src/index.js";

const explicitTestConfig = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

type TestWebSocket = {
  close: () => void;
  send: (data: string) => void;
  terminate: () => void;
  on: {
    (event: "close", handler: (code: number, reason: Buffer) => void): void;
    (event: "message", handler: (data: string | Buffer | ArrayBuffer) => void): void;
  };
};

type WebSocketInjectableApp = {
  injectWS: (path: string, upgradeContext?: {
    headers?: Record<string, string>;
  }) => Promise<TestWebSocket>;
};

const productionConfig = parseOrchServerConfig({
  environment: "production",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "production-service-token",
});

describe("Node WS Fastify route harness", () => {
  const fixture = loadContractFixtures().fakeNodeReconnect;

  function createRegistry(nowMs = 1_700_000_000_000): {
    registry: InMemoryNodeRegistry;
    sessionCache: PerNodeSessionCache;
  } {
    const sessionCache = new PerNodeSessionCache();
    return {
      registry: new InMemoryNodeRegistry({
        sessionCache,
        nowMs: () => nowMs,
      }),
      sessionCache,
    };
  }

  it("does not expose /ws/node on the default app", async () => {
    const app = createApp({ config: explicitTestConfig });

    const response = await app.inject({ method: "GET", url: "/ws/node" });

    expect(response.statusCode).toBe(404);
    expect("injectWS" in app).toBe(false);

    await app.close();
  });

  it("rejects unauthenticated and invalid bearer handshakes before upgrade", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: productionConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const injectable = app as unknown as WebSocketInjectableApp;
    await expect(injectable.injectWS("/ws/node")).rejects.toThrow(
      "Unexpected server response: 401",
    );
    await expect(
      injectable.injectWS("/ws/node", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    ).rejects.toThrow("Unexpected server response: 403");
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("rejects production handshakes when AUTH_BEARER_TOKEN is not configured", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: parseOrchServerConfig({
        environment: "production",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: "",
      }),
      nodeWsRoute: { registry },
    });

    await app.ready();
    await expect(
      (app as unknown as WebSocketInjectableApp).injectWS("/ws/node"),
    ).rejects.toThrow("Unexpected server response: 503");

    await app.close();
  });

  it("accepts a valid production bearer and registers the node", async () => {
    const { registry } = createRegistry();
    const resolveTokenAccess = vi.fn(async () => ({
      ok: false as const,
      statusCode: 401,
      detail: "HTTP auth should not own node WebSocket authentication",
    }));
    const app = createApp({
      config: productionConfig,
      productionAuth: { resolveTokenAccess },
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app, "production-service-token");
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });
    expect(resolveTokenAccess).not.toHaveBeenCalled();

    ws.terminate();
    await app.close();
  });

  it("wires register, refresh, message relay, and close through a per-connection controller", async () => {
    const { registry, sessionCache } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const registered = registry.getConnectedNode("fake-node");

    expect(registered).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });

    ws.send(
      JSON.stringify({
        type: "node_register",
        node_id: "fake-node",
        host: "10.0.0.2",
        port: 4305,
        agents: [{ id: "codex-agent", name: "Codex Agent", backend: "codex" }],
        capabilities: { app_heartbeat_v1: true },
        supported_backends: ["codex", "claude"],
        sessions: fixture.sessionsUpdateAfterReconnect.sessions,
      }),
    );
    await waitFor(
      () => registry.getConnectedNode("fake-node")?.host === "10.0.0.2",
    );

    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: registered?.connectionId,
      host: "10.0.0.2",
      port: 4305,
      supportedBackends: ["codex", "claude"],
    });
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      connectionId: registered?.connectionId,
      status: "running",
      fresh: true,
    });

    ws.send(JSON.stringify(fixture.eventRelay));
    await waitFor(() => sessionCache.findSession("sess-contract")?.lastEventId === 1);
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      fresh: true,
      lastEventId: 1,
    });

    ws.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    expect(registry.getNodeState("fake-node")).toMatchObject({
      connectionId: registered?.connectionId,
      status: "disconnected",
    });

    await app.close();
  });

  it("echoes the same sentAt in pong across two heartbeat windows", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    for (const sentAt of ["2026-07-10T06:00:00.000Z", "2026-07-10T06:00:30.000Z"]) {
      const pong = waitForMessage(ws);
      ws.send(JSON.stringify({ type: "app_heartbeat_ping", sentAt }));
      await expect(pong).resolves.toBe(
        JSON.stringify({ type: "app_heartbeat_pong", sentAt }),
      );
      expect(registry.getConnectedNode("fake-node")).toMatchObject({
        status: "connected",
        heartbeat: { lastPingAtMs: 1_700_000_000_000 },
      });
    }

    ws.terminate();
    await app.close();
  });

  it("closes an unregistered connection when the registration deadline expires", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, registrationTimeoutMs: 20 },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    await expect(waitForClose(ws)).resolves.toEqual({
      code: 4001,
      reason: "registration timeout",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("closes invalid JSON with an observable protocol error", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send("{not-json");

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: "invalid JSON frame",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("closes a non-node_register first frame with a policy violation", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "event" }));

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "EXPECTED_NODE_REGISTER",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("attaches transport only after successful node_register and detaches the same connection on close", async () => {
    const { registry } = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);

    expect(transportHub.listAttached()).toEqual([]);

    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const connectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    expect(transportHub.has({ nodeId: "fake-node", connectionId })).toBe(true);

    ws.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    expect(transportHub.has({ nodeId: "fake-node", connectionId })).toBe(false);

    await app.close();
  });

  it("cleans registry and transport once when socket close is followed by app shutdown", async () => {
    const { registry } = createRegistry();
    const disconnectNode = vi.spyOn(registry, "disconnectNode");
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    ws.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    await app.close();

    expect(disconnectNode).toHaveBeenCalledTimes(1);
    expect(transportHub.listAttached()).toEqual([]);
  });

  it("closes unsupported non-object JSON payloads instead of dropping them", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    const closed = waitForClose(ws);
    ws.send(JSON.stringify(["node_register"]));

    await expect(closed).resolves.toEqual({
      code: 1003,
      reason: "unsupported JSON frame",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("keeps stale route connection messages and close events from touching the current connection", async () => {
    const { registry, sessionCache } = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, transportHub },
    });

    await app.ready();
    const oldWs = await injectAuthenticatedWs(app);
    oldWs.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const firstConnectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    const currentWs = await injectAuthenticatedWs(app);
    currentWs.send(JSON.stringify(fixture.registration));
    await waitFor(
      () =>
        registry.getConnectedNode("fake-node")?.connectionId !==
        firstConnectionId,
    );
    const currentConnectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: currentConnectionId }),
    ).toBe(true);
    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: firstConnectionId }),
    ).toBe(false);

    oldWs.send(JSON.stringify(fixture.eventRelay));
    await delay(20);
    expect(sessionCache.findSession("sess-contract")).toBeUndefined();

    oldWs.terminate();
    await delay(20);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: currentConnectionId,
      status: "connected",
    });
    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: currentConnectionId }),
    ).toBe(true);

    currentWs.terminate();
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);
    expect(
      transportHub.has({ nodeId: "fake-node", connectionId: currentConnectionId }),
    ).toBe(false);

    await app.close();
  });

  it("passes frame events to an optional sink without letting sink failures break the route", async () => {
    const { registry, sessionCache } = createRegistry();
    const eventSink = vi.fn((events: NodeRegistryEvent[]): void => {
      expect(events.length).toBeGreaterThan(0);
      throw new Error("sink failure");
    });
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry, eventSink },
    });

    await app.ready();
    const ws = await injectAuthenticatedWs(app);
    ws.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    ws.send(JSON.stringify(fixture.eventRelay));
    await waitFor(() => sessionCache.findSession("sess-contract")?.lastEventId === 1);

    expect(eventSink).toHaveBeenCalledTimes(2);
    expect(eventSink.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "node_registered", nodeId: "fake-node" }),
      ]),
    );
    expect(eventSink.mock.calls[1]?.[0]).toEqual([
      {
        type: "node_session_event",
        nodeId: "fake-node",
        data: fixture.eventRelay,
      },
    ]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });

    ws.terminate();
    await app.close();
  });
});

function waitForClose(ws: TestWebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function waitForMessage(ws: TestWebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      resolve(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });
  });
}

function injectAuthenticatedWs(app: unknown, token = "test-token"): Promise<TestWebSocket> {
  return (app as WebSocketInjectableApp).injectWS("/ws/node", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function requireDefined<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}
