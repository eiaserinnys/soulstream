import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  PerNodeSessionCache,
  SessionCommandRouter,
  SessionRouteNoAvailableNodesError,
  SessionRouteNodeUnavailableError,
  SessionRouteSessionOwnerMissingError,
  loadContractFixtures,
  type AgentProfileRecord,
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
    const connectionId = registry.registerNode({
      ...(reconnect.registration as NodeRegistrationPayload),
      node_id: nodeId,
    }).node.connectionId;
    registry.receiveNodeMessage(nodeId, {
      type: "runner_inventory",
      running_session_ids: [],
    });
    return connectionId;
  }

  const dbProfile: AgentProfileRecord = {
    agentId: "fake-agent",
    name: "DB Agent",
    atomContexts: [],
    defaultPreset: "db-preset",
    aliases: [{ id: "db-alias", default_preset: "alias-preset" }],
    hasPortrait: false,
    portrait: null,
    version: 1,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };

  async function createExistingSession(
    registry: InMemoryNodeRegistry,
    nodeId: string,
  ): Promise<void> {
    const command = registry.createCommand(
      nodeId,
      reconnect.command as CreateSessionNodeCommandPayload,
    );
    registry.receiveNodeMessage(nodeId, {
      type: "session_created",
      session: { agent_session_id: "sess-contract", status: "running" },
    });
    registry.receiveNodeMessage(nodeId, {
      ...reconnect.ack,
      requestId: command.requestId,
    });
    await expect(command.result).resolves.toMatchObject({
      type: "session_created",
      agentSessionId: "sess-contract",
    });
  }

  it("preserves Python registration order when equally loaded nodes are compatible", () => {
    const { registry } = createRegistry();
    registerNode(registry, "z-node");
    registerNode(registry, "a-node");
    const router = new SessionCommandRouter({ registry });

    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "new-session",
      prompt: "hello",
    });

    expect(routed.node.nodeId).toBe("z-node");
    expect(routed.command.message).toMatchObject({
      type: "create_session",
      agentSessionId: "new-session",
      prompt: "hello",
      requestId: "router-create_session-1-1700000000000",
    });
    expect(registry.getConnectedNode("z-node")).toMatchObject({
      pendingCommandCount: 1,
    });
    expect(registry.getConnectedNode("a-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("uses DB aliases and default presets over the node YAML registration", () => {
    const { registry } = createRegistry();
    registry.registerNode({
      ...(reconnect.registration as NodeRegistrationPayload),
      node_id: "db-node",
      agents: [{
        id: "fake-agent",
        name: "YAML Agent",
        backend: "codex",
        default_preset: "yaml-preset",
        aliases: ["yaml-alias"],
      }],
      supported_backends: ["codex"],
      model_presets: [
        { id: "yaml-preset", backend: "codex", available: true },
        { id: "db-preset", backend: "codex", available: true },
        { id: "alias-preset", backend: "codex", available: true },
      ],
    });
    registry.receiveNodeMessage("db-node", {
      type: "runner_inventory",
      running_session_ids: [],
    });
    const router = new SessionCommandRouter({
      registry,
      agentProfiles: () => [dbProfile],
    });

    const canonical = router.createSession({
      type: "create_session",
      agentSessionId: "canonical-session",
      prompt: "hello",
      profile: "fake-agent",
    });
    const alias = router.createSession({
      type: "create_session",
      agentSessionId: "alias-session",
      prompt: "hello",
      profile: "db-alias",
    });

    expect(canonical.command.message).toMatchObject({
      profile: "fake-agent",
      model_preset: "db-preset",
    });
    expect(alias.command.message).toMatchObject({
      profile: "fake-agent",
      model_preset: "alias-preset",
    });
    expect(() => router.createSession({
      type: "create_session",
      agentSessionId: "stale-yaml-alias-session",
      prompt: "hello",
      profile: "yaml-alias",
    })).toThrowError(/not registered/);
  });

  it("routes respond to the fresh connected owner and preserves inputRequestId separately", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "fake-node");
    await createExistingSession(registry, "fake-node");
    const router = new SessionCommandRouter({ registry });

    const routed = await router.respond({
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

    const routed = await router.subscribeEvents({
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

  it("routes an expired cache entry through the durable session owner", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "durable-node");
    const findSessionOwnerNodeId = vi.fn(async (agentSessionId: string) =>
      agentSessionId === "expired-session" ? "durable-node" : null
    );
    const router = new SessionCommandRouter({
      registry,
      findSessionOwnerNodeId,
    });

    const routed = await router.respond({
      type: "respond",
      agentSessionId: "expired-session",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
    });

    expect(findSessionOwnerNodeId).toHaveBeenCalledWith("expired-session");
    expect(routed.node.nodeId).toBe("durable-node");
    expect(routed.command.message).toMatchObject({
      type: "respond",
      agentSessionId: "expired-session",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
    });
  });

  it("routes a stale cache entry through the connected durable session owner", async () => {
    const { registry } = createRegistry();
    const firstConnectionId = registerNode(registry, "cached-node");
    await createExistingSession(registry, "cached-node");
    const findSessionOwnerNodeId = vi.fn(async (agentSessionId: string) =>
      agentSessionId === "sess-contract" ? "durable-node" : null
    );
    const router = new SessionCommandRouter({
      registry,
      findSessionOwnerNodeId,
    });

    expect(registry.disconnectNode("cached-node", "network close")).toMatchObject({
      type: "node_unregistered",
      connectionId: firstConnectionId,
    });
    registerNode(registry, "cached-node");
    const durableConnectionId = registerNode(registry, "durable-node");

    const routed = await router.respond({
      type: "respond",
      agentSessionId: "sess-contract",
      inputRequestId: "input-req-contract",
      answers: { choice: "yes" },
    });

    expect(findSessionOwnerNodeId).toHaveBeenCalledWith("sess-contract");
    expect(routed.node).toMatchObject({
      nodeId: "durable-node",
      connectionId: durableConnectionId,
    });
  });

  it("reports the durable owner node as unavailable when a stale cache entry cannot route to it", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "cached-node");
    await createExistingSession(registry, "cached-node");
    registry.disconnectNode("cached-node", "network close");
    registerNode(registry, "cached-node");
    const router = new SessionCommandRouter({
      registry,
      findSessionOwnerNodeId: async () => "offline-durable-node",
    });

    await expect(
      router.respond({
        type: "respond",
        agentSessionId: "sess-contract",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).rejects.toMatchObject({
      name: "SessionRouteNodeUnavailableError",
      code: "NODE_UNAVAILABLE",
      agentSessionId: "sess-contract",
      nodeId: "offline-durable-node",
    });
  });

  it("reports a missing durable owner when a stale cache entry has no database row", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "cached-node");
    await createExistingSession(registry, "cached-node");
    registry.disconnectNode("cached-node", "network close");
    registerNode(registry, "cached-node");
    const router = new SessionCommandRouter({
      registry,
      findSessionOwnerNodeId: async () => null,
    });

    await expect(
      router.respond({
        type: "respond",
        agentSessionId: "sess-contract",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).rejects.toMatchObject({
      name: "SessionRouteSessionOwnerMissingError",
      code: "SESSION_OWNER_MISSING",
      agentSessionId: "sess-contract",
    });
  });

  it("uses explicit error types for no node, missing owner, and unavailable owner", async () => {
    const { registry, sessionCache } = createRegistry();
    const router = new SessionCommandRouter({
      registry,
      findSessionOwnerNodeId: async (agentSessionId) =>
        agentSessionId === "offline-durable-session" ? "offline-node" : null,
    });

    expect(() =>
      router.createSession({
        type: "create_session",
        agentSessionId: "new-session",
        prompt: "hello",
      }),
    ).toThrow(SessionRouteNoAvailableNodesError);
    await expect(
      router.respond({
        type: "respond",
        agentSessionId: "missing-session",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).rejects.toThrow(SessionRouteSessionOwnerMissingError);
    await expect(
      router.respond({
        type: "respond",
        agentSessionId: "offline-durable-session",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).rejects.toThrow(SessionRouteNodeUnavailableError);

    registerNode(registry, "fresh-node");
    await createExistingSession(registry, "fresh-node");
    registry.disconnectNode("fresh-node", "network close");

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

    await expect(
      router.respond({
        type: "respond",
        agentSessionId: "ghost-session",
        inputRequestId: "input-req-contract",
        answers: {},
      }),
    ).rejects.toThrow(SessionRouteNodeUnavailableError);
  });

  it("does not leave pending entries when command creation rejects an invalid payload", async () => {
    const { registry } = createRegistry();
    registerNode(registry, "fake-node");
    await createExistingSession(registry, "fake-node");
    const router = new SessionCommandRouter({ registry });

    await expect(
      router.respond({
        type: "respond",
        agentSessionId: "sess-contract",
        inputRequestId: "input-req-contract",
        answers: {},
        requestId: "input-req-contract",
      } as unknown as RespondNodeCommandPayload),
    ).rejects.toThrow(
      "requestId is reserved for node command correlation; use inputRequestId",
    );
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });
});
