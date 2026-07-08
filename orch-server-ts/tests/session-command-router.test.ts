import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  PerNodeSessionCache,
  SessionCommandRouter,
  SessionRouteNoAvailableNodesError,
  SessionRouteNodeUnavailableError,
  SessionRouteSessionOwnerMissingError,
  SessionRouteSessionOwnerStaleError,
  loadContractFixtures,
  type CreateSessionNodeCommandPayload,
  type NodeRegistrationPayload,
  type RespondNodeCommandPayload,
} from "../src/index.js";

describe("Session command router primitive", () => {
  const fixtures = loadContractFixtures();
  const reconnect = fixtures.fakeNodeReconnect;
  const upstream = fixtures.upstreamWsWire;

  function createRegistry(nowMs = 1_700_000_000_000): {
    registry: InMemoryNodeRegistry;
    sessionCache: PerNodeSessionCache;
  } {
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
      nowMs: () => nowMs,
      requestIdGenerator: ({ sequence, commandType, nowMs }) =>
        `router-${commandType}-${sequence}-${nowMs}`,
    });
    return { registry, sessionCache };
  }

  function registerNode(
    registry: InMemoryNodeRegistry,
    nodeId: string,
  ): string {
    return registry.registerNode({
      ...(reconnect.registration as NodeRegistrationPayload),
      node_id: nodeId,
    }).node.connectionId;
  }

  async function createExistingSession(
    registry: InMemoryNodeRegistry,
    nodeId: string,
  ): Promise<void> {
    const command = registry.createCommand(
      nodeId,
      reconnect.command as CreateSessionNodeCommandPayload,
    );
    registry.receiveNodeMessage(nodeId, {
      ...reconnect.ack,
      requestId: command.requestId,
    });
    await expect(command.result).resolves.toMatchObject({
      type: "session_created",
      agentSessionId: "sess-contract",
    });
  }

  it("routes new create_session commands to the deterministic first connected node", () => {
    const { registry } = createRegistry();
    registerNode(registry, "z-node");
    registerNode(registry, "a-node");
    const router = new SessionCommandRouter({ registry });

    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "new-session",
      prompt: "hello",
    });

    expect(routed.node.nodeId).toBe("a-node");
    expect(routed.command.message).toMatchObject({
      type: "create_session",
      agentSessionId: "new-session",
      prompt: "hello",
      requestId: "router-create_session-1-1700000000000",
    });
    expect(registry.getConnectedNode("a-node")).toMatchObject({
      pendingCommandCount: 1,
    });
    expect(registry.getConnectedNode("z-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("routes respond to the fresh connected owner and preserves inputRequestId separately", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "fake-node");
    await createExistingSession(registry, "fake-node");
    const router = new SessionCommandRouter({ registry });

    const routed = router.respond({
      type: "respond",
      agentSessionId: upstream.outbound.respond.agentSessionId,
      inputRequestId: upstream.outbound.respond.inputRequestId,
      answers: upstream.outbound.respond.answers,
    });

    expect(routed.node.nodeId).toBe("fake-node");
    expect(routed.command.message).toMatchObject({
      type: "respond",
      agentSessionId: "sess-contract",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
      requestId: "router-respond-2-1700000000000",
    });
    expect(routed.command.message.requestId).not.toBe(
      routed.command.message.inputRequestId,
    );
  });

  it("keeps subscribe_events fire-and-forget and leaves no pending entry", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "fake-node");
    await createExistingSession(registry, "fake-node");
    const router = new SessionCommandRouter({ registry });

    const routed = router.subscribeEvents({
      type: "subscribe_events",
      agentSessionId: upstream.outbound.subscribeEvents.agentSessionId,
      subscribeId: upstream.outbound.subscribeEvents.subscribeId,
    });

    expect(routed.node.nodeId).toBe("fake-node");
    expect(routed.command).toEqual({
      fireAndForget: true,
      message: {
        type: "subscribe_events",
        agentSessionId: "sess-contract",
        subscribeId: "<uuid>",
      },
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("does not route through a stale owner after reconnect until sessions_update refreshes it", async () => {
    const { registry } = createRegistry();
    const firstConnectionId = registerNode(registry, "fake-node");
    await createExistingSession(registry, "fake-node");
    const router = new SessionCommandRouter({ registry });

    expect(registry.disconnectNode("fake-node", "network close")).toMatchObject({
      type: "node_unregistered",
      connectionId: firstConnectionId,
    });
    const secondConnectionId = registerNode(registry, "fake-node");

    expect(() =>
      router.respond({
        type: "respond",
        agentSessionId: "sess-contract",
        inputRequestId: "input-req-contract",
        answers: { choice: "yes" },
      }),
    ).toThrow(SessionRouteSessionOwnerStaleError);

    registry.receiveNodeMessage("fake-node", reconnect.sessionsUpdateAfterReconnect);

    const routed = router.respond({
      type: "respond",
      agentSessionId: "sess-contract",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
    });

    expect(routed.node.connectionId).toBe(secondConnectionId);
  });

  it("uses explicit error types for no node, missing owner, stale owner, and unavailable owner", async () => {
    const { registry, sessionCache } = createRegistry();
    const router = new SessionCommandRouter({ registry });

    expect(() =>
      router.createSession({
        type: "create_session",
        agentSessionId: "new-session",
        prompt: "hello",
      }),
    ).toThrow(SessionRouteNoAvailableNodesError);
    expect(() =>
      router.respond({
        type: "respond",
        agentSessionId: "missing-session",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).toThrow(SessionRouteSessionOwnerMissingError);

    registerNode(registry, "fresh-node");
    await createExistingSession(registry, "fresh-node");
    registry.disconnectNode("fresh-node", "network close");

    expect(() =>
      router.respond({
        type: "respond",
        agentSessionId: "sess-contract",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).toThrow(SessionRouteSessionOwnerStaleError);

    sessionCache.replaceNodeSessions({
      nodeId: "ghost-node",
      connectionId: "ghost-node:1",
      sessions: [
        {
          agentSessionId: "ghost-session",
          status: "running",
          last_event_id: 1,
        },
      ],
      nowMs: 1_700_000_000_000,
    });

    expect(() =>
      router.respond({
        type: "respond",
        agentSessionId: "ghost-session",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).toThrow(SessionRouteNodeUnavailableError);
  });

  it("does not leave pending entries when command creation rejects an invalid payload", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "fake-node");
    await createExistingSession(registry, "fake-node");
    const router = new SessionCommandRouter({ registry });

    expect(() =>
      router.respond({
        type: "respond",
        agentSessionId: "sess-contract",
        inputRequestId: "input-req-contract",
        answers: {},
        requestId: "input-req-contract",
      } as unknown as RespondNodeCommandPayload),
    ).toThrow(
      "requestId is reserved for node command correlation; use inputRequestId",
    );
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });
});
