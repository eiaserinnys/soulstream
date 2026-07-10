import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeWsFrameController,
  PerNodeSessionCache,
  loadContractFixtures,
  type CreateSessionNodeCommandPayload,
  type NodeRegistrationPayload,
} from "../src/index.js";

describe("Node WS frame controller primitive", () => {
  const fixture = loadContractFixtures().fakeNodeReconnect;

  function createController(nowMs = 1_700_000_000_000): {
    controller: NodeWsFrameController;
    registry: InMemoryNodeRegistry;
    sessionCache: PerNodeSessionCache;
  } {
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
      nowMs: () => nowMs,
      requestIdGenerator: ({ sequence, commandType }) =>
        `frame-${commandType}-${sequence}`,
    });
    return {
      controller: new NodeWsFrameController({ registry }),
      registry,
      sessionCache,
    };
  }

  it("rejects non-node_register and invalid node_id before registration", () => {
    const { controller, registry } = createController();

    expect(controller.handleFrame({ type: "event" })).toEqual({
      type: "registration_rejected",
      code: "EXPECTED_NODE_REGISTER",
      messageType: "event",
    });
    expect(controller.handleFrame({ type: "node_register" })).toEqual({
      type: "registration_rejected",
      code: "NODE_ID_REQUIRED",
      messageType: "node_register",
    });
    expect(
      controller.handleFrame({ type: "node_register", node_id: 123 }),
    ).toEqual({
      type: "registration_rejected",
      code: "NODE_ID_INVALID",
      messageType: "node_register",
    });
    expect(registry.listConnectedNodes()).toEqual([]);
  });

  it("registers the first valid frame and routes later messages with connectionId", () => {
    const { controller, registry, sessionCache } = createController();
    const registration = fixture.registration as NodeRegistrationPayload;

    const registered = controller.handleFrame(registration);

    expect(registered).toMatchObject({
      type: "registered",
      nodeId: "fake-node",
    });
    expect(registered.type === "registered" ? registered.connectionId : "").toBe(
      registry.getConnectedNode("fake-node")?.connectionId,
    );

    expect(controller.handleFrame(fixture.eventRelay)).toEqual({
      type: "message",
      nodeId: "fake-node",
      connectionId:
        registered.type === "registered" ? registered.connectionId : "",
      events: [
        {
          type: "node_session_event",
          nodeId: "fake-node",
          data: fixture.eventRelay,
        },
      ],
    });
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      fresh: true,
      lastEventId: 1,
    });
  });

  it("records app heartbeat ping and emits a pong with the same sentAt", () => {
    const { controller } = createController();
    const registered = controller.handleFrame(
      fixture.registration as NodeRegistrationPayload,
    );
    if (registered.type !== "registered") throw new Error("registration failed");

    const sentAt = "2026-07-10T06:00:00.000Z";
    expect(
      controller.handleFrame({ type: "app_heartbeat_ping", sentAt }),
    ).toEqual({
      type: "message",
      nodeId: "fake-node",
      connectionId: registered.connectionId,
      events: [{ type: "node_heartbeat_ping", nodeId: "fake-node" }],
      outboundFrames: [{ type: "app_heartbeat_pong", sentAt }],
    });
  });

  it("refreshes a post-registration node_register without reconnecting or clearing pending commands", async () => {
    const { controller, registry, sessionCache } = createController();
    const registered = controller.handleFrame(
      fixture.registration as NodeRegistrationPayload,
    );
    if (registered.type !== "registered") throw new Error("registration failed");
    const pending = registry.createCommand(
      "fake-node",
      fixture.command as CreateSessionNodeCommandPayload,
    );

    const refreshed = controller.handleFrame({
      type: "node_register",
      node_id: "fake-node",
      host: "10.0.0.2",
      port: 4305,
      agents: [{ id: "codex-agent", name: "Codex Agent", backend: "codex" }],
      capabilities: { max_concurrent: 2, app_heartbeat_v1: true },
      supported_backends: ["codex", "claude"],
      sessions: fixture.sessionsUpdateAfterReconnect.sessions,
    });

    expect(refreshed).toMatchObject({
      type: "registration_refreshed",
      nodeId: "fake-node",
      connectionId: registered.connectionId,
    });
    expect(refreshed.type === "registration_refreshed" ? refreshed.events : []).toEqual([
      {
        type: "node_updated",
        nodeId: "fake-node",
        connectionId: registered.connectionId,
        node: expect.objectContaining({
          host: "10.0.0.2",
          port: 4305,
          agents: [
            { id: "codex-agent", name: "Codex Agent", backend: "codex" },
          ],
          supportedBackends: ["codex", "claude"],
          pendingCommandCount: 1,
        }),
      },
      {
        type: "node_session_sessions_update",
        nodeId: "fake-node",
        data: {
          type: "sessions_update",
          sessions: fixture.sessionsUpdateAfterReconnect.sessions,
        },
      },
    ]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: registered.connectionId,
      pendingCommandCount: 1,
      capabilities: { max_concurrent: 2, app_heartbeat_v1: true },
    });
    expect(sessionCache.findSession("sess-contract")).toMatchObject({
      nodeId: "fake-node",
      connectionId: registered.connectionId,
      status: "running",
      fresh: true,
      lastEventId: 1,
    });

    registry.receiveNodeMessage(
      { nodeId: "fake-node", connectionId: registered.connectionId },
      { ...fixture.ack, requestId: pending.requestId },
    );
    await expect(pending.result).resolves.toMatchObject({
      requestId: pending.requestId,
    });
  });

  it("ignores a node_register refresh for a different node_id", () => {
    const { controller, registry } = createController();
    const registered = controller.handleFrame(
      fixture.registration as NodeRegistrationPayload,
    );
    if (registered.type !== "registered") throw new Error("registration failed");

    expect(
      controller.handleFrame({
        type: "node_register",
        node_id: "other-node",
        agents: [{ id: "wrong-agent", name: "Wrong Agent" }],
      }),
    ).toEqual({
      type: "registration_refresh_ignored",
      nodeId: "fake-node",
      connectionId: registered.connectionId,
      events: [
        {
          type: "ignored_node_registration_refresh",
          nodeId: "fake-node",
          connectionId: registered.connectionId,
          incomingNodeId: "other-node",
          reason: "node_id_mismatch",
        },
      ],
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: registered.connectionId,
      agents: (fixture.registration as NodeRegistrationPayload).agents,
    });
  });

  it("keeps stale replaced connection messages and close events from touching the current connection", () => {
    const sessionCache = new PerNodeSessionCache();
    const registry = new InMemoryNodeRegistry({
      sessionCache,
    });
    const oldController = new NodeWsFrameController({ registry });
    const currentController = new NodeWsFrameController({ registry });
    const registration = fixture.registration as NodeRegistrationPayload;

    const first = oldController.handleFrame(registration);
    const second = currentController.handleFrame(registration);
    if (first.type !== "registered" || second.type !== "registered") {
      throw new Error("registration failed");
    }

    expect(second.events.map((event) => event.type)).toEqual([
      "node_unregistered",
      "node_registered",
    ]);
    expect(oldController.handleFrame(fixture.eventRelay)).toEqual({
      type: "message",
      nodeId: "fake-node",
      connectionId: first.connectionId,
      events: [
        {
          type: "ignored_stale_message",
          nodeId: "fake-node",
          connectionId: first.connectionId,
          currentConnectionId: second.connectionId,
          messageType: "event",
        },
      ],
    });
    expect(oldController.close("late close")).toEqual({
      type: "closed",
      nodeId: "fake-node",
      connectionId: first.connectionId,
      event: {
        type: "ignored_stale_disconnect",
        nodeId: "fake-node",
        connectionId: first.connectionId,
      },
    });
    expect(registry.getConnectedNode("fake-node")?.connectionId).toBe(
      second.connectionId,
    );
    expect(currentController.close("network close")).toEqual({
      type: "closed",
      nodeId: "fake-node",
      connectionId: second.connectionId,
      event: {
        type: "node_unregistered",
        nodeId: "fake-node",
        connectionId: second.connectionId,
        reason: "network close",
      },
    });
  });
});
