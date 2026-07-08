import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportError,
  NodeCommandTransportHub,
  PerNodeSessionCache,
  SessionCommandTransportBridge,
  SessionCommandRouter,
  loadContractFixtures,
  type CreateSessionNodeCommandPayload,
  type NodeRegistrationPayload,
} from "../src/index.js";

describe("Node command transport bridge", () => {
  const fixtures = loadContractFixtures();
  const reconnect = fixtures.fakeNodeReconnect;

  function createRegistry(nowMs = 1_700_000_000_000): {
    registry: InMemoryNodeRegistry;
    sessionCache: PerNodeSessionCache;
  } {
    const sessionCache = new PerNodeSessionCache();
    return {
      registry: new InMemoryNodeRegistry({
        sessionCache,
        nowMs: () => nowMs,
        requestIdGenerator: ({ sequence, commandType, nowMs }) =>
          `bridge-${commandType}-${sequence}-${nowMs}`,
      }),
      sessionCache,
    };
  }

  function registerNode(
    registry: InMemoryNodeRegistry,
    nodeId = "fake-node",
  ): string {
    return registry.registerNode({
      ...(reconnect.registration as NodeRegistrationPayload),
      node_id: nodeId,
    }).node.connectionId;
  }

  async function createExistingSession(
    registry: InMemoryNodeRegistry,
    nodeId = "fake-node",
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
      agentSessionId: "sess-contract",
    });
  }

  it("sends a routed pending command over the matching node transport and settles through receiveNodeMessage", async () => {
    const { registry } = createRegistry();
    const connectionId = registerNode(registry);
    const transports = new NodeCommandTransportHub();
    const sent: string[] = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: { send: (data) => { sent.push(data); } },
    });
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });

    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "sess-contract",
      prompt: "contract prompt",
    });
    const result = bridge.sendPendingCommand(routed);

    expect(sent).toEqual([JSON.stringify(routed.command.message)]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 1,
    });

    registry.receiveNodeMessage(
      { nodeId: "fake-node", connectionId },
      { ...reconnect.ack, requestId: routed.command.requestId },
    );

    await expect(result).resolves.toMatchObject({
      type: "session_created",
      requestId: routed.command.requestId,
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("sends routed fire-and-forget commands without creating pending entries", async () => {
    const { registry } = createRegistry();
    const connectionId = registerNode(registry);
    await createExistingSession(registry);
    const transports = new NodeCommandTransportHub();
    const sent: string[] = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: { send: (data) => { sent.push(data); } },
    });
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });

    const routed = router.subscribeEvents({
      type: "subscribe_events",
      agentSessionId: "sess-contract",
      subscribeId: "sub-1",
    });
    await bridge.sendFireAndForgetCommand(routed);

    expect(sent).toEqual([JSON.stringify(routed.command.message)]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("rejects pending commands and throws an explicit error when transport is missing", async () => {
    const { registry } = createRegistry();
    registerNode(registry);
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({
      registry,
      transports: new NodeCommandTransportHub(),
    });

    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "sess-contract",
      prompt: "contract prompt",
    });

    await expect(bridge.sendPendingCommand(routed)).rejects.toMatchObject({
      code: "TRANSPORT_MISSING",
      nodeId: "fake-node",
      connectionId: routed.node.connectionId,
    });
    await expect(routed.command.result).rejects.toMatchObject({
      requestId: routed.command.requestId,
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("does not send to a stale connection after reconnect and leaves no pending entry", async () => {
    const { registry } = createRegistry();
    const firstConnectionId = registerNode(registry);
    const transports = new NodeCommandTransportHub();
    const oldSent: string[] = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId: firstConnectionId,
      transport: { send: (data) => { oldSent.push(data); } },
    });
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "sess-contract",
      prompt: "contract prompt",
    });

    const secondConnectionId = registerNode(registry);
    transports.attach({
      nodeId: "fake-node",
      connectionId: secondConnectionId,
      transport: { send: () => undefined },
    });

    await expect(bridge.sendPendingCommand(routed)).rejects.toMatchObject({
      code: "TRANSPORT_STALE",
      nodeId: "fake-node",
      connectionId: firstConnectionId,
    });
    await expect(routed.command.result).rejects.toMatchObject({
      requestId: routed.command.requestId,
    });
    expect(oldSent).toEqual([]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: secondConnectionId,
      pendingCommandCount: 0,
    });
  });

  it("does not reject the current pending command when a stale routed command shares its requestId", async () => {
    const { registry } = createRegistry();
    const firstConnectionId = registerNode(registry);
    const transports = new NodeCommandTransportHub();
    const oldSent: string[] = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId: firstConnectionId,
      transport: { send: (data) => { oldSent.push(data); } },
    });
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const oldRouted = router.createSession({
      type: "create_session",
      agentSessionId: "old-session",
      prompt: "old prompt",
    });

    const secondConnectionId = registerNode(registry);
    const currentSent: string[] = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId: secondConnectionId,
      transport: { send: (data) => { currentSent.push(data); } },
    });
    const currentRouted = router.createSession({
      type: "create_session",
      agentSessionId: "current-session",
      prompt: "current prompt",
    });

    expect(currentRouted.command.requestId).toBe(oldRouted.command.requestId);

    await expect(bridge.sendPendingCommand(oldRouted)).rejects.toMatchObject({
      code: "TRANSPORT_STALE",
      nodeId: "fake-node",
      connectionId: firstConnectionId,
    });
    await expect(oldRouted.command.result).rejects.toMatchObject({
      requestId: oldRouted.command.requestId,
    });
    expect(oldSent).toEqual([]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: secondConnectionId,
      pendingCommandCount: 1,
    });

    const currentResult = bridge.sendPendingCommand(currentRouted);
    expect(currentSent).toEqual([JSON.stringify(currentRouted.command.message)]);
    registry.receiveNodeMessage(
      { nodeId: "fake-node", connectionId: secondConnectionId },
      {
        ...reconnect.ack,
        agentSessionId: "current-session",
        requestId: currentRouted.command.requestId,
      },
    );

    await expect(currentResult).resolves.toMatchObject({
      requestId: currentRouted.command.requestId,
      agentSessionId: "current-session",
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      connectionId: secondConnectionId,
      pendingCommandCount: 0,
    });
  });

  it("rejects pending commands when JSON serialization fails before send", async () => {
    const { registry } = createRegistry();
    const connectionId = registerNode(registry);
    const transports = new NodeCommandTransportHub();
    const sent: string[] = [];
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: { send: (data) => { sent.push(data); } },
    });
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "sess-contract",
      prompt: "contract prompt",
      circular,
    });

    const sendResult = bridge.sendPendingCommand(routed);
    await expect(sendResult).rejects.toBeInstanceOf(NodeCommandTransportError);
    await expect(sendResult).rejects.toMatchObject({
      code: "TRANSPORT_JSON_FAILED",
    });
    await expect(routed.command.result).rejects.toMatchObject({
      requestId: routed.command.requestId,
    });
    expect(sent).toEqual([]);
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("rejects pending commands when transport send fails", async () => {
    const { registry } = createRegistry();
    const connectionId = registerNode(registry);
    const transports = new NodeCommandTransportHub();
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: () => {
          throw new Error("socket closed");
        },
      },
    });
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const routed = router.createSession({
      type: "create_session",
      agentSessionId: "sess-contract",
      prompt: "contract prompt",
    });

    await expect(bridge.sendPendingCommand(routed)).rejects.toMatchObject({
      code: "TRANSPORT_SEND_FAILED",
    });
    await expect(routed.command.result).rejects.toMatchObject({
      requestId: routed.command.requestId,
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });

  it("throws explicit fire-and-forget errors without pending side effects", async () => {
    const { registry } = createRegistry();
    registerNode(registry);
    await createExistingSession(registry);
    const router = new SessionCommandRouter({ registry });
    const bridge = new SessionCommandTransportBridge({
      registry,
      transports: new NodeCommandTransportHub(),
    });

    const routed = router.subscribeEvents({
      type: "subscribe_events",
      agentSessionId: "sess-contract",
      subscribeId: "sub-1",
    });

    await expect(bridge.sendFireAndForgetCommand(routed)).rejects.toMatchObject({
      code: "TRANSPORT_MISSING",
    });
    expect(registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
  });
});
