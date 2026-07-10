import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  InMemoryNodeStreamBroadcaster,
  NodeSnapshotService,
  createApp,
  loadContractFixtures,
  nodeSnapshotRouteAuthRequirements,
  parseOrchServerConfig,
  type NodeRegistrationPayload,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("node snapshot and stream route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps read-only node routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/api/nodes" })).toMatchObject({
      statusCode: 404,
    });
    expect(await app.inject({ method: "GET", url: "/api/nodes/stream" })).toMatchObject({
      statusCode: 404,
    });

    await app.close();
  });

  it("registers the Python node list and stream auth contract when explicitly enabled", async () => {
    const { app } = createHarness();

    expect(nodeSnapshotRouteAuthRequirements).toEqual({
      "GET /api/nodes": true,
      "GET /api/nodes/stream": true,
    });
    expect(
      fixtures.routeInventory.routes
        .filter((route) => route.name === "list_nodes" || route.name === "node_stream")
        .map((route) => [route.methods[0], route.path, route.authRequired]),
    ).toEqual([
      ["GET", "/api/nodes", true],
      ["GET", "/api/nodes/stream", true],
    ]);
    expect(await app.inject({ method: "GET", url: "/api/nodes/node-a/agents" })).toMatchObject({
      statusCode: 404,
    });

    await app.close();
  });

  it("projects connected registry nodes with Python-compatible list shape", async () => {
    const { app, registry } = createHarness(() => 1_700_000_000_000);
    const connectionId = registerNode(registry, "node-a");

    registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId },
      {
        type: "sessions_update",
        sessions: [
          { agentSessionId: "sess-a", status: "running" },
          { agent_session_id: "sess-b", status: "waiting" },
        ],
      },
    );

    const response = await app.inject({ method: "GET", url: "/api/nodes" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0]).toMatchObject({
      nodeId: "node-a",
      host: "127.0.0.1",
      port: 4105,
      capabilities: { board_yjs_host: true },
      supportedBackends: ["claude", "codex"],
      connectedAt: "2023-11-14T22:13:20.000Z",
      sessionCount: 2,
      status: "connected",
      connectionId,
      connectedAtMs: 1_700_000_000_000,
      lastSeenAtMs: 1_700_000_000_000,
      pendingCommandCount: 0,
      heartbeat: {
        supported: false,
      },
    });

    registry.disconnectNode("node-a", { connectionId, reason: "test_disconnect" });
    expect((await app.inject({ method: "GET", url: "/api/nodes" })).json()).toEqual({
      nodes: [],
    });

    await app.close();
  });

  it("sends the initial node stream snapshot as a bare JSON array", async () => {
    const { app, registry } = createHarness(() => 1_700_000_000_000, {
      closeAfterInitialSnapshot: true,
    });
    registerNode(registry, "node-a");

    const response = await app.inject({
      method: "GET",
      url: "/api/nodes/stream",
    });
    const snapshot = parseSseFrame(response.body, "snapshot") as Array<
      Record<string, unknown>
    >;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      nodeId: "node-a",
      connectedAt: "2023-11-14T22:13:20.000Z",
      sessionCount: 0,
      status: "connected",
    });
    expect(response.body).not.toContain("stream_meta");
    expect(response.body).not.toContain("id:");

    await app.close();
  });

  it("maps registry events to Python-compatible node stream events", () => {
    const { registry, snapshotService, broadcaster } = createHarness(
      () => 1_700_000_000_000,
    );
    const registered = registry.registerNode(registration("node-a"));

    expect(broadcaster.publishRegistryEvents(registered.events)).toEqual([
      {
        event: "node_connected",
        data: snapshotService.listNodes().nodes[0],
      },
    ]);

    const updatedEvents = registry.refreshNodeRegistration(
      {
        nodeId: "node-a",
        connectionId: registered.node.connectionId,
      },
      {
        type: "node_register",
        node_id: "node-a",
        host: "127.0.0.2",
        port: 4306,
      },
    );
    expect(broadcaster.publishRegistryEvents(updatedEvents)).toEqual([
      {
        event: "node_updated",
        data: expect.objectContaining({
          nodeId: "node-a",
          host: "127.0.0.2",
          port: 4306,
        }),
      },
    ]);

    const disconnected = registry.disconnectNode("node-a", {
      connectionId: registered.node.connectionId,
      reason: "test_disconnect",
    });
    expect(broadcaster.publishRegistryEvents([disconnected])).toEqual([
      {
        event: "node_disconnected",
        data: { nodeId: "node-a" },
      },
    ]);
  });
});

function createHarness(
  nowMs: () => number = () => Date.now(),
  options: { closeAfterInitialSnapshot?: boolean } = {},
) {
  const registry = new InMemoryNodeRegistry({ nowMs });
  const snapshotService = new NodeSnapshotService({ registry });
  const broadcaster = new InMemoryNodeStreamBroadcaster({ snapshotService });
  const app = createApp({
    config,
    nodeSnapshotRoutes: {
      snapshotService,
      broadcaster,
      closeAfterInitialSnapshot: options.closeAfterInitialSnapshot,
    },
  });
  return { app, registry, snapshotService, broadcaster };
}

function registerNode(registry: InMemoryNodeRegistry, nodeId: string): string {
  registry.registerNode(registration(nodeId));
  const node = registry.getConnectedNode(nodeId);
  if (node === undefined) {
    throw new Error(`node did not register: ${nodeId}`);
  }
  return node.connectionId;
}

function registration(nodeId: string): NodeRegistrationPayload {
  return {
    type: "node_register",
    node_id: nodeId,
    host: "127.0.0.1",
    port: 4105,
    agents: [],
    capabilities: { board_yjs_host: true },
    supported_backends: ["claude", "codex"],
  };
}

function parseSseFrame(body: string, eventName: string): unknown {
  for (const frame of body.split("\n\n")) {
    const lines = frame.split("\n");
    if (lines[0] !== `event: ${eventName}`) continue;
    const data = lines.find((line) => line.startsWith("data: "));
    if (data === undefined) {
      throw new Error(`SSE frame is missing data: ${eventName}`);
    }
    return JSON.parse(data.slice("data: ".length));
  }
  throw new Error(`SSE frame not found: ${eventName}`);
}
