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
  on: (event: "close", handler: (code: number, reason: Buffer) => void) => void;
};

type WebSocketInjectableApp = {
  injectWS: (path: string) => Promise<TestWebSocket>;
};

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
        heartbeatTimeoutMs: 1_000,
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

  it("wires register, refresh, message relay, and close through a per-connection controller", async () => {
    const { registry, sessionCache } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS("/ws/node");
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

  it("closes invalid JSON with an observable protocol error", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS("/ws/node");
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
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS("/ws/node");
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
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS("/ws/node");

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

  it("closes unsupported non-object JSON payloads instead of dropping them", async () => {
    const { registry } = createRegistry();
    const app = createApp({
      config: explicitTestConfig,
      nodeWsRoute: { registry },
    });

    await app.ready();
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS("/ws/node");
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
    const oldWs = await (app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
    );
    oldWs.send(JSON.stringify(fixture.registration));
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const firstConnectionId = requireDefined(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    const currentWs = await (app as unknown as WebSocketInjectableApp).injectWS(
      "/ws/node",
    );
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
    const ws = await (app as unknown as WebSocketInjectableApp).injectWS("/ws/node");
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

function waitForClose(
  ws: TestWebSocket,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireDefined<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}
