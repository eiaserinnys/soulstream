import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
} from "../src/index.js";

const explicitTestConfig = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

interface TestWebSocket {
  send: (data: string) => void;
  pong: (data?: Buffer) => void;
  terminate: () => void;
  on(event: "close", handler: (code: number, reason: Buffer) => void): void;
  on(event: "message", handler: (data: string | Buffer | ArrayBuffer) => void): void;
  on(event: "ping", handler: () => void): void;
}

type WebSocketInjectableApp = {
  injectWS: (path: string, upgradeContext?: {
    headers?: Record<string, string>;
  }) => Promise<TestWebSocket>;
};

describe("Node control lane liveness", () => {
  const fixture = loadContractFixtures().fakeNodeReconnect;

  function createRegistry(): InMemoryNodeRegistry {
    return new InMemoryNodeRegistry({
      sessionCache: new PerNodeSessionCache(),
      nowMs: () => 1_700_000_000_000,
    });
  }

  function createAppWithControlLiveness(input: {
    registry: InMemoryNodeRegistry;
    transportHub: NodeCommandTransportHub;
    controlPingIntervalMs: number;
    controlPingMissLimit: number;
  }): ReturnType<typeof createApp> {
    return createApp({
      config: explicitTestConfig,
      nodeWsRoute: {
        registry: input.registry,
        nodeCredentials: null,
        transportHub: input.transportHub,
        controlPingIntervalMs: input.controlPingIntervalMs,
        controlPingMissLimit: input.controlPingMissLimit,
      },
    });
  }

  async function registerDataWithControlLane(
    app: unknown,
  ): Promise<{ dataWs: TestWebSocket; connectionId: string }> {
    const dataWs = await injectAuthenticatedWs(app);
    const registrationAck = waitForMessage(dataWs);
    dataWs.send(JSON.stringify({
      ...fixture.registration,
      capabilities: {
        ...((fixture.registration as Record<string, unknown>).capabilities as
          Record<string, unknown> | undefined ?? {}),
        control_channel_v1: true,
      },
    }));
    const ack = JSON.parse(await registrationAck) as Record<string, unknown>;
    return { dataWs, connectionId: requireDefined(ack.connection_id as string) };
  }

  async function attachControlLane(
    app: unknown,
    connectionId: string,
  ): Promise<TestWebSocket> {
    const controlWs = await injectAuthenticatedWs(
      app,
      "test-token",
      "/ws/node/control",
    );
    const registrationAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({
      type: "node_control_register",
      node_id: "fake-node",
      connection_id: connectionId,
    }));
    await registrationAck;
    const readyAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({ type: "node_control_ready" }));
    await readyAck;
    return controlWs;
  }

  it("keeps a control lane that answers protocol pings", async () => {
    const registry = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createAppWithControlLiveness({
      registry,
      transportHub,
      controlPingIntervalMs: 20,
      controlPingMissLimit: 2,
    });

    await app.ready();
    const { dataWs, connectionId } = await registerDataWithControlLane(app);
    const controlWs = await attachControlLane(app, connectionId);
    // The injectWS test client does not answer protocol pings on its own;
    // this socket behaves like a healthy node and pongs every ping.
    let pings = 0;
    controlWs.on("ping", () => {
      pings += 1;
      controlWs.pong();
    });

    await delay(120);

    expect(pings).toBeGreaterThanOrEqual(2);
    // The hub still resolves the control lane after several ping intervals.
    const probe = waitForMessage(controlWs);
    await transportHub.get({ nodeId: "fake-node", connectionId })?.send(
      "control-probe",
    );
    await expect(probe).resolves.toBe("control-probe");

    controlWs.terminate();
    dataWs.terminate();
    await app.close();
  });

  it("drops a control lane that never answers a ping and falls back to the data lane", async () => {
    const registry = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const app = createAppWithControlLiveness({
      registry,
      transportHub,
      controlPingIntervalMs: 20,
      controlPingMissLimit: 2,
    });

    await app.ready();
    const { dataWs, connectionId } = await registerDataWithControlLane(app);
    const controlWs = await attachControlLane(app, connectionId);
    // The peer stays silent: it never answers a protocol ping, so only the
    // server-side liveness check can notice the half-open lane.
    let pings = 0;
    controlWs.on("ping", () => {
      pings += 1;
    });

    await waitForClose(controlWs);
    expect(pings).toBeGreaterThanOrEqual(1);

    const probe = waitForMessage(dataWs);
    await transportHub.get({ nodeId: "fake-node", connectionId })?.send(
      "data-probe",
    );
    await expect(probe).resolves.toBe("data-probe");

    dataWs.terminate();
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

function injectAuthenticatedWs(
  app: unknown,
  token = "test-token",
  path = "/ws/node",
): Promise<TestWebSocket> {
  return (app as WebSocketInjectableApp).injectWS(path, {
    headers: { authorization: `Bearer ${token}` },
  });
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function requireDefined<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) {
    throw new Error("expected value to be defined");
  }
  return value;
}
