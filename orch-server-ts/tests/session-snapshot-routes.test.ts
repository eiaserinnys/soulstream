import { describe, expect, it } from "vitest";

import {
  createApp,
  InMemoryNodeRegistry,
  loadContractFixtures,
  parseOrchServerConfig,
  SessionSnapshotService,
  sessionSnapshotRouteAuthRequirements,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session snapshot route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps the read-only sessions route disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/api/sessions" })).toMatchObject({
      statusCode: 404,
    });

    await app.close();
  });

  it("registers the Python list_sessions auth contract when explicitly enabled", async () => {
    const { app } = createHarness();

    expect(sessionSnapshotRouteAuthRequirements).toEqual({
      "GET /api/sessions": true,
    });
    expect(
      fixtures.routeInventory.routes
        .filter((route) => route.name === "list_sessions")
        .map((route) => [route.methods[0], route.path, route.authRequired]),
    ).toEqual([["GET", "/api/sessions", true]]);
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-1/rename",
        payload: { title: "not this phase" },
      }),
    ).toMatchObject({ statusCode: 404 });

    await app.close();
  });

  it("projects cached node sessions with Python-compatible list shape", async () => {
    const { app, registry } = createHarness(() => 1_700_000_000_000);
    const connectionId = registerNode(registry, "node-a");

    registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId },
      {
        type: "session_updated",
        agentSessionId: "sess-a",
        title: "Alpha",
        folderId: "folder-a",
        session_type: "agent",
        status: "running",
        last_event_id: 11,
      },
    );

    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      total: 1,
      cursor: null,
      nextCursor: null,
      hasMore: false,
    });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessionList).toEqual(body.sessions);
    expect(body.sessions[0]).toMatchObject({
      agent_session_id: "sess-a",
      agentSessionId: "sess-a",
      nodeId: "node-a",
      title: "Alpha",
      folderId: "folder-a",
      session_type: "agent",
      status: "running",
      last_event_id: 11,
      connected: true,
      fresh: true,
    });

    registry.disconnectNode("node-a", { connectionId, reason: "test_disconnect" });
    const disconnected = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(disconnected.sessions[0]).toMatchObject({
      agent_session_id: "sess-a",
      connected: false,
      fresh: false,
    });

    await app.close();
  });

  it("sorts, paginates, and applies folder/type/feed-only filters deterministically", async () => {
    let nowMs = 1_000;
    const { app, registry } = createHarness(() => nowMs);
    const connectionId = registerNode(registry, "node-a");

    registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId },
      {
        type: "session_updated",
        agentSessionId: "sess-b",
        folder_id: "folder-a",
        session_type: "llm",
        status: "running",
      },
    );
    registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId },
      {
        type: "session_updated",
        agentSessionId: "sess-a",
        folder_id: "folder-a",
        session_type: "agent",
        status: "running",
      },
    );
    nowMs = 2_000;
    registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId },
      {
        type: "session_updated",
        agentSessionId: "sess-c",
        folder_id: "folder-b",
        session_type: "agent",
        status: "running",
      },
    );

    const firstPage = (
      await app.inject({ method: "GET", url: "/api/sessions?limit=2" })
    ).json();
    expect(
      firstPage.sessions.map(
        (session: Record<string, unknown>) => session.agent_session_id,
      ),
    ).toEqual(["sess-c", "sess-a"]);
    expect(firstPage).toMatchObject({
      total: 3,
      cursor: "2",
      nextCursor: "2",
      hasMore: true,
    });

    const secondPage = (
      await app.inject({ method: "GET", url: "/api/sessions?cursor=2&limit=2" })
    ).json();
    expect(
      secondPage.sessions.map(
        (session: Record<string, unknown>) => session.agent_session_id,
      ),
    ).toEqual(["sess-b"]);
    expect(secondPage).toMatchObject({
      total: 3,
      cursor: null,
      nextCursor: null,
      hasMore: false,
    });

    const filtered = (
      await app.inject({
        method: "GET",
        url: "/api/sessions?folderId=folder-a&session_type=agent&feed_only=true",
      })
    ).json();
    expect(
      filtered.sessions.map(
        (session: Record<string, unknown>) => session.agent_session_id,
      ),
    ).toEqual(["sess-a"]);
    expect(filtered).toMatchObject({
      total: 1,
      cursor: null,
      nextCursor: null,
      hasMore: false,
    });

    const unbounded = (
      await app.inject({ method: "GET", url: "/api/sessions?limit=0" })
    ).json();
    expect(
      unbounded.sessions.map(
        (session: Record<string, unknown>) => session.agent_session_id,
      ),
    ).toEqual(["sess-c", "sess-a", "sess-b"]);
    expect(unbounded).toMatchObject({
      total: 3,
      cursor: null,
      nextCursor: null,
      hasMore: false,
    });

    await app.close();
  });
});

function createHarness(nowMs: () => number = () => Date.now()) {
  const registry = new InMemoryNodeRegistry({ nowMs });
  const snapshotService = new SessionSnapshotService({ registry });
  const app = createApp({
    config,
    sessionSnapshotRoutes: { snapshotService },
  });
  return { app, registry, snapshotService };
}

function registerNode(registry: InMemoryNodeRegistry, nodeId: string): string {
  registry.registerNode({
    type: "node_register",
    node_id: nodeId,
    host: "127.0.0.1",
    port: 4105,
    agents: [],
  });
  const node = registry.getConnectedNode(nodeId);
  if (node === undefined) {
    throw new Error(`node did not register: ${nodeId}`);
  }
  return node.connectionId;
}
