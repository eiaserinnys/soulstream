import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
} from "../src/index.js";
import type {
  NodeCredentialResolver,
  NodePrincipal,
} from "../src/node_credentials/types.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const fixture = loadContractFixtures().fakeNodeReconnect;

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

function principalFor(nodeId: string, credentialId = "credential-1"): NodePrincipal {
  return { credential_id: credentialId, node_id: nodeId, company_pc: false };
}

function createFakeNodeCredentials(principal: NodePrincipal, token = "node-token") {
  const listeners = new Set<(revoked: NodePrincipal) => void>();
  const resolver: NodeCredentialResolver = {
    resolve: (candidate) => (candidate === token ? principal : null),
    onRevoked: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    resolver,
    revoke: () => {
      for (const listener of Array.from(listeners)) listener(principal);
    },
  };
}

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({ nowMs: () => 1_700_000_000_000 });
}

function injectWs(
  app: unknown,
  token: string,
  path = "/ws/node",
): Promise<TestWebSocket> {
  return (app as WebSocketInjectableApp).injectWS(path, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function waitForMessage(ws: TestWebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      resolve(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    });
  });
}

function waitForClose(ws: TestWebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("node credential binding on the node websocket", () => {
  it("registers its own node_id with a node credential token", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const ws = await injectWs(app, "node-token");
    const ack = waitForMessage(ws);
    ws.send(JSON.stringify(fixture.registration));

    expect(JSON.parse(await ack)).toMatchObject({
      type: "node_register_ack",
      node_id: "fake-node",
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      nodeId: "fake-node",
      status: "connected",
    });

    ws.terminate();
    await app.close();
  });

  it("keeps the shared service token working on the same route", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const ws = await injectWs(app, "test-token");
    const ack = waitForMessage(ws);
    ws.send(JSON.stringify(fixture.registration));

    expect(JSON.parse(await ack)).toMatchObject({ type: "node_register_ack" });
    expect(registry.getConnectedNode("fake-node")).toBeDefined();

    ws.terminate();
    await app.close();
  });

  it("rejects a first registration that names another node_id", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const ws = await injectWs(app, "node-token");
    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ ...fixture.registration, node_id: "other-node" }));

    expect(await closed).toEqual({
      code: 1008,
      reason: "node_id does not match node credential",
    });
    expect(registry.listConnectedNodes()).toEqual([]);

    await app.close();
  });

  it("rejects a catalog refresh that switches node_id", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const ws = await injectWs(app, "node-token");
    const ack = waitForMessage(ws);
    ws.send(JSON.stringify(fixture.registration));
    await ack;
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ ...fixture.registration, node_id: "other-node" }));

    expect(await closed).toEqual({
      code: 1008,
      reason: "node_id does not match node credential",
    });

    await app.close();
  });

  it("rejects a node_id takeover by a different credential", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const legacy = await injectWs(app, "test-token");
    const legacyAck = waitForMessage(legacy);
    legacy.send(JSON.stringify(fixture.registration));
    await legacyAck;
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const heldConnectionId = registry.getConnectedNode("fake-node")?.connectionId;

    const takeover = await injectWs(app, "node-token");
    const closed = waitForClose(takeover);
    takeover.send(JSON.stringify(fixture.registration));

    expect(await closed).toEqual({
      code: 1008,
      reason: "node_id is held by a different credential",
    });
    expect(registry.getConnectedNode("fake-node")?.connectionId).toBe(heldConnectionId);

    legacy.terminate();
    await app.close();
  });

  it("rejects the shared token taking over a credential-held node_id", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const credentialed = await injectWs(app, "node-token");
    const credentialedAck = waitForMessage(credentialed);
    credentialed.send(JSON.stringify(fixture.registration));
    await credentialedAck;
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const heldConnectionId = registry.getConnectedNode("fake-node")?.connectionId;

    const legacy = await injectWs(app, "test-token");
    const closed = waitForClose(legacy);
    legacy.send(JSON.stringify(fixture.registration));

    expect(await closed).toEqual({
      code: 1008,
      reason: "node_id is held by a different credential",
    });
    expect(registry.getConnectedNode("fake-node")?.connectionId).toBe(heldConnectionId);

    credentialed.terminate();
    await app.close();
  });

  it("still lets the same credential reconnect and replace its connection", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const first = await injectWs(app, "node-token");
    const firstAck = waitForMessage(first);
    first.send(JSON.stringify(fixture.registration));
    await firstAck;
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);
    const firstConnectionId = registry.getConnectedNode("fake-node")?.connectionId;

    const second = await injectWs(app, "node-token");
    const secondAck = waitForMessage(second);
    second.send(JSON.stringify(fixture.registration));
    expect(JSON.parse(await secondAck)).toMatchObject({ type: "node_register_ack" });

    expect(registry.getConnectedNode("fake-node")?.connectionId).not.toBe(firstConnectionId);

    second.terminate();
    await app.close();
  });

  it("closes node and control websockets when the credential is revoked", async () => {
    const registry = createRegistry();
    const transportHub = new NodeCommandTransportHub();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver, transportHub },
    });

    await app.ready();
    const dataWs = await injectWs(app, "node-token");
    const dataAck = waitForMessage(dataWs);
    dataWs.send(JSON.stringify({
      ...fixture.registration,
      capabilities: { control_channel_v1: true },
    }));
    const connectionId = JSON.parse(await dataAck).connection_id as string;
    await waitFor(() => registry.getConnectedNode("fake-node") !== undefined);

    const controlWs = await injectWs(app, "node-token", "/ws/node/control");
    const controlAck = waitForMessage(controlWs);
    controlWs.send(JSON.stringify({
      type: "node_control_register",
      node_id: "fake-node",
      connection_id: connectionId,
    }));
    await controlAck;

    const dataClosed = waitForClose(dataWs);
    const controlClosed = waitForClose(controlWs);
    credentials.revoke();

    expect(await dataClosed).toEqual({ code: 1008, reason: "node credential revoked" });
    expect(await controlClosed).toEqual({ code: 1008, reason: "node credential revoked" });
    await waitFor(() => registry.getConnectedNode("fake-node") === undefined);

    await app.close();
  });

  it("rejects a control attach naming another node_id", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const otherNodeWs = await injectWs(app, "test-token");
    const otherNodeAck = waitForMessage(otherNodeWs);
    otherNodeWs.send(JSON.stringify({
      ...fixture.registration,
      node_id: "other-node",
      capabilities: { control_channel_v1: true },
    }));
    const otherConnectionId = JSON.parse(await otherNodeAck).connection_id as string;
    await waitFor(() => registry.getConnectedNode("other-node") !== undefined);

    const controlWs = await injectWs(app, "node-token", "/ws/node/control");
    const closed = waitForClose(controlWs);
    controlWs.send(JSON.stringify({
      type: "node_control_register",
      node_id: "other-node",
      connection_id: otherConnectionId,
    }));

    expect(await closed).toEqual({
      code: 1008,
      reason: "node_id does not match node credential",
    });

    otherNodeWs.terminate();
    await app.close();
  });

  it("keeps legacy reconnects replacing each other", async () => {
    const registry = createRegistry();
    const credentials = createFakeNodeCredentials(principalFor("fake-node"));
    const resolve = vi.spyOn(credentials.resolver, "resolve");
    const app = createApp({
      config,
      nodeWsRoute: { registry, nodeCredentials: credentials.resolver },
    });

    await app.ready();
    const first = await injectWs(app, "test-token");
    const firstAck = waitForMessage(first);
    first.send(JSON.stringify(fixture.registration));
    await firstAck;

    const second = await injectWs(app, "test-token");
    const secondAck = waitForMessage(second);
    second.send(JSON.stringify(fixture.registration));
    expect(JSON.parse(await secondAck)).toMatchObject({ type: "node_register_ack" });
    expect(resolve).not.toHaveBeenCalled();

    second.terminate();
    await app.close();
  });
});
