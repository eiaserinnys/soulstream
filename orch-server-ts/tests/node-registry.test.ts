import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  PerNodeSessionCache,
  loadContractFixtures,
  type CreateSessionNodeCommandPayload,
  type NodeRegistrationPayload,
} from "../src/index.js";

describe("Node registry and per-node session cache primitive", () => {
  const fixture = loadContractFixtures().fakeNodeReconnect;

  function createRegistry(nowMs = 1_700_000_000_000): {
    registry: InMemoryNodeRegistry;
    sessionCache: PerNodeSessionCache;
  } {
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
      nowMs: () => nowMs,
      requestIdGenerator: ({ sequence, commandType, nowMs }) =>
        `node-req-${commandType}-${sequence}-${nowMs}`,
    });
    return { registry, sessionCache };
  }

  it("fixes register-ack-event-disconnect-reconnect-sessions_update transitions from the fixture", async () => {
    const { registry, sessionCache } = createRegistry();
    const registration = fixture.registration as NodeRegistrationPayload;

    const registered = registry.registerNode(registration);

    expect(registered.event).toMatchObject({
      type: "node_registered",
      nodeId: "fake-node",
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      nodeId: "fake-node",
      connectionId: registered.node.connectionId,
      connected: true,
      lastSeenAtMs: 1_700_000_000_000,
    });
    expect(sessionCache.getSessionsForNode("fake-node")).toEqual([]);

    const command = registry.createCommand(
      "fake-node",
      fixture.command as CreateSessionNodeCommandPayload,
    );

    expect(command.message).toMatchObject({
      type: "create_session",
      agentSessionId: "sess-contract",
      prompt: "contract prompt",
      requestId: "node-req-create_session-1-1700000000000",
    });

    const ackEffects = registry.receiveNodeMessage("fake-node", {
      ...fixture.ack,
      requestId: command.requestId,
    });

    await expect(command.result).resolves.toMatchObject({
      type: "session_created",
      requestId: command.requestId,
      agentSessionId: "sess-contract",
    });
    expect(ackEffects).toEqual([
      {
        type: "command_ack",
        nodeId: "fake-node",
        requestId: command.requestId,
        commandType: "create_session",
      },
    ]);
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      agentSessionId: "sess-contract",
      status: "created",
      fresh: true,
      lastEventId: undefined,
    });
    expect(registry.findConnectedNodeForSession("sess-contract")?.connectionId).toBe(
      registered.node.connectionId,
    );

    const relayEffects = registry.receiveNodeMessage(
      "fake-node",
      fixture.eventRelay,
    );

    expect(relayEffects).toEqual([
      {
        type: "node_session_event",
        nodeId: "fake-node",
        data: fixture.eventRelay,
      },
    ]);
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      lastEventId: 1,
      fresh: true,
    });

    const disconnected = registry.disconnectNode("fake-node", "network close");

    expect(disconnected).toMatchObject({
      type: "node_unregistered",
      nodeId: "fake-node",
      connectionId: registered.node.connectionId,
      reason: "network close",
    });
    expect(registry.getConnectedNode("fake-node")).toBeUndefined();
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      fresh: false,
    });
    expect(registry.findConnectedNodeForSession("sess-contract")).toBeUndefined();

    const reconnected = registry.registerNode(registration);
    expect(reconnected.replacedConnectionId).toBeUndefined();
    expect(registry.findConnectedNodeForSession("sess-contract")).toBeUndefined();

    const updateEffects = registry.receiveNodeMessage(
      "fake-node",
      fixture.sessionsUpdateAfterReconnect,
    );

    expect(updateEffects).toEqual([
      {
        type: "node_session_sessions_update",
        nodeId: "fake-node",
        data: fixture.sessionsUpdateAfterReconnect,
      },
    ]);
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      connectionId: reconnected.node.connectionId,
      status: "running",
      fresh: true,
      lastEventId: 1,
    });
    expect(registry.findConnectedNodeForSession("sess-contract")?.connectionId).toBe(
      reconnected.node.connectionId,
    );
    expect(sessionCache.getSessionsForNode("fake-node")).toHaveLength(1);
  });

  it("replaces duplicate node registration without letting stale disconnect remove the new connection", () => {
    const { registry } = createRegistry();
    const registration = fixture.registration as NodeRegistrationPayload;

    const first = registry.registerNode(registration);
    const second = registry.registerNode(registration);

    expect(second.replacedConnectionId).toBe(first.node.connectionId);
    expect(second.events.map((event) => event.type)).toEqual([
      "node_unregistered",
      "node_registered",
    ]);
    expect(registry.getConnectedNode("fake-node")?.connectionId).toBe(
      second.node.connectionId,
    );

    expect(
      registry.disconnectNode("fake-node", {
        connectionId: first.node.connectionId,
        reason: "late close from replaced socket",
      }),
    ).toEqual({
      type: "ignored_stale_disconnect",
      nodeId: "fake-node",
      connectionId: first.node.connectionId,
    });
    expect(registry.getConnectedNode("fake-node")?.connectionId).toBe(
      second.node.connectionId,
    );
  });

  it("ignores late messages from a replaced connection without mutating current state", async () => {
    let nowMs = 1_000;
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
      nowMs: () => nowMs,
      requestIdGenerator: ({ sequence, commandType }) =>
        `current-${commandType}-${sequence}`,
    });
    const registration = fixture.registration as NodeRegistrationPayload;

    const first = registry.registerNode(registration);
    nowMs = 1_100;
    const second = registry.registerNode(registration);
    const currentCommand = registry.createCommand(
      "fake-node",
      fixture.command as CreateSessionNodeCommandPayload,
    );

    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: second.node.connectionId,
      lastSeenAtMs: 1_100,
      pendingCommandCount: 1,
    });

    nowMs = 1_200;
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: first.node.connectionId,
        },
        fixture.eventRelay,
      ),
    ).toEqual([
      {
        type: "ignored_stale_message",
        nodeId: "fake-node",
        connectionId: first.node.connectionId,
        currentConnectionId: second.node.connectionId,
        messageType: "event",
      },
    ]);
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: first.node.connectionId,
        },
        {
          type: "sessions_update",
          sessions: [
            {
              agentSessionId: "stale-session",
              status: "running",
              last_event_id: 999,
            },
          ],
        },
      ),
    ).toEqual([
      {
        type: "ignored_stale_message",
        nodeId: "fake-node",
        connectionId: first.node.connectionId,
        currentConnectionId: second.node.connectionId,
        messageType: "sessions_update",
      },
    ]);
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: first.node.connectionId,
        },
        {
          ...fixture.ack,
          requestId: currentCommand.requestId,
        },
      ),
    ).toEqual([
      {
        type: "ignored_stale_message",
        nodeId: "fake-node",
        connectionId: first.node.connectionId,
        currentConnectionId: second.node.connectionId,
        messageType: "session_created",
      },
    ]);

    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: second.node.connectionId,
      lastSeenAtMs: 1_100,
      pendingCommandCount: 1,
    });
    expect(sessionCache.findSession("sess-contract")).toBeUndefined();
    expect(sessionCache.findSession("stale-session")).toBeUndefined();

    nowMs = 1_300;
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: second.node.connectionId,
        },
        {
          ...fixture.ack,
          requestId: currentCommand.requestId,
        },
      ),
    ).toEqual([
      {
        type: "command_ack",
        nodeId: "fake-node",
        requestId: currentCommand.requestId,
        commandType: "create_session",
      },
    ]);
    await expect(currentCommand.result).resolves.toMatchObject({
      type: "session_created",
      requestId: currentCommand.requestId,
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: second.node.connectionId,
      lastSeenAtMs: 1_300,
      pendingCommandCount: 0,
    });
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      connectionId: second.node.connectionId,
      fresh: true,
    });
  });

  it("tracks heartbeat observations without owning a second liveness timeout", () => {
    let nowMs = 1_000;
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
      nowMs: () => nowMs,
    });

    registry.registerNode({
      ...(fixture.registration as NodeRegistrationPayload),
      node_id: "heartbeat-node",
      capabilities: { app_heartbeat_v1: true },
    });
    registry.registerNode({
      ...(fixture.registration as NodeRegistrationPayload),
      node_id: "legacy-node",
      capabilities: {},
    });

    nowMs = 1_250;
    expect(
      registry.receiveNodeMessage("heartbeat-node", {
        type: "app_heartbeat_pong",
      }),
    ).toEqual([
      {
        type: "node_heartbeat_pong",
        nodeId: "heartbeat-node",
      },
    ]);
    expect(registry.getConnectedNode("heartbeat-node")).toMatchObject({
      lastSeenAtMs: 1_250,
      heartbeat: {
        supported: true,
        lastPongAtMs: 1_250,
      },
    });

    nowMs = 1_750;
    expect(registry.getConnectedNode("heartbeat-node")).toMatchObject({
      nodeId: "heartbeat-node",
      connected: true,
      lastSeenAtMs: 1_250,
      heartbeat: { supported: true, lastPongAtMs: 1_250 },
    });
    expect(registry.getConnectedNode("legacy-node")).toMatchObject({
      nodeId: "legacy-node",
      connected: true,
      heartbeat: { supported: false },
    });
  });

  it("recognizes request-id-free direct node session messages and updates the session cache", () => {
    const { registry, sessionCache } = createRegistry();
    const registered = registry.registerNode(
      fixture.registration as NodeRegistrationPayload,
    );

    const created = {
      type: "session_created",
      agentSessionId: "direct-session",
      folderId: "folder-1",
      session: {
        agentSessionId: "direct-session",
        title: "Direct Session",
        status: "starting",
      },
    };
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: registered.node.connectionId,
        },
        created,
      ),
    ).toEqual([
      {
        type: "node_session_session_created",
        nodeId: "fake-node",
        data: created,
      },
    ]);
    expect(sessionCache.findSession("direct-session")).toMatchObject({
      nodeId: "fake-node",
      connectionId: registered.node.connectionId,
      agentSessionId: "direct-session",
      status: "starting",
      fresh: true,
    });

    const updated = {
      type: "session_updated",
      agentSessionId: "direct-session",
      status: "running",
      last_event_id: 7,
    };
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: registered.node.connectionId,
        },
        updated,
      ),
    ).toEqual([
      {
        type: "node_session_session_updated",
        nodeId: "fake-node",
        data: updated,
      },
    ]);
    expect(sessionCache.findSession("direct-session")).toMatchObject({
      status: "running",
      fresh: true,
      lastEventId: 7,
    });

    const catalogUpdated = {
      type: "catalog_updated",
      catalog: {
        folders: [{ id: "folder-1" }],
        sessions: [{ agentSessionId: "direct-session", folderId: "folder-1" }],
      },
    };
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: registered.node.connectionId,
        },
        catalogUpdated,
      ),
    ).toEqual([
      {
        type: "node_session_event",
        nodeId: "fake-node",
        data: catalogUpdated,
      },
    ]);

    const deleted = {
      type: "session_deleted",
      agentSessionId: "direct-session",
    };
    expect(
      registry.receiveNodeMessage(
        {
          nodeId: "fake-node",
          connectionId: registered.node.connectionId,
        },
        deleted,
      ),
    ).toEqual([
      {
        type: "node_session_session_deleted",
        nodeId: "fake-node",
        data: deleted,
      },
    ]);
    expect(sessionCache.findSession("direct-session")).toBeUndefined();
  });
});
