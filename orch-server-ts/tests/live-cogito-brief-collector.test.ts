import { describe, expect, it, vi } from "vitest";

import {
  CogitoBriefTimeoutError,
  CogitoBriefUnavailableError,
  createLiveCogitoBriefCollector,
  InMemoryNodeRegistry,
  NodeCommandTransportError,
  NodeCommandTransportHub,
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  SessionCommandTransportBridge,
  type CogitoNode,
  type LiveCogitoCommandBridge,
  type RequestResponseNodeCommandPayload,
} from "../src/index.js";

const node: CogitoNode = {
  id: "node-a",
  host: "127.0.0.1",
  port: 4105,
  capabilities: { reflect_brief: true },
};

describe("live cogito brief collector", () => {
  it("sends reflect_brief through the command transport bridge with timeoutMs", async () => {
    const registry = createRegistry();
    const connectionId = registerNode(registry);
    const transports = new NodeCommandTransportHub();
    const sent: Array<Record<string, unknown>> = [];
    transports.attach({
      nodeId: node.id,
      connectionId,
      transport: { send: (data) => { sent.push(JSON.parse(data) as Record<string, unknown>); } },
    });
    const bridge = new SessionCommandTransportBridge({ registry, transports });
    const createCommandSpy = vi.spyOn(registry, "createCommand");
    const collector = createLiveCogitoBriefCollector({ registry, bridge });

    const result = collector.reflectBrief(node, 2.25);

    expect(createCommandSpy).toHaveBeenCalledWith(
      node.id,
      { type: "reflect_brief" },
      { timeoutMs: 2250 },
    );
    expect(sent).toEqual([
      {
        type: "reflect_brief",
        requestId: "brief-reflect_brief-1-1700000000000",
      },
    ]);

    registry.receiveNodeMessage(
      { nodeId: node.id, connectionId },
      {
        type: "reflect_brief",
        requestId: "brief-reflect_brief-1-1700000000000",
        ok: true,
        checked_at: "2026-07-09T04:00:00.000Z",
        brief: { package: "@soulstream/soul-server-ts" },
      },
    );

    await expect(result).resolves.toMatchObject({
      type: "reflect_brief",
      checked_at: "2026-07-09T04:00:00.000Z",
      brief: { package: "@soulstream/soul-server-ts" },
    });
  });

  it("maps missing transport to Cogito brief unavailable", async () => {
    const registry = createRegistry();
    registerNode(registry);
    const bridge = new SessionCommandTransportBridge({
      registry,
      transports: new NodeCommandTransportHub(),
    });
    const collector = createLiveCogitoBriefCollector({ registry, bridge });

    await expect(collector.reflectBrief(node, 5)).rejects.toBeInstanceOf(
      CogitoBriefUnavailableError,
    );
  });

  it("maps disconnected nodes to Cogito brief unavailable before creating a command", async () => {
    const registry = createRegistry();
    registerNode(registry);
    registry.disconnectNode(node.id, "closed");
    const bridge = new SessionCommandTransportBridge({
      registry,
      transports: new NodeCommandTransportHub(),
    });
    const collector = createLiveCogitoBriefCollector({ registry, bridge });
    const createCommandSpy = vi.spyOn(registry, "createCommand");

    await expect(collector.reflectBrief(node, 5)).rejects.toBeInstanceOf(
      CogitoBriefUnavailableError,
    );
    expect(createCommandSpy).not.toHaveBeenCalled();
  });

  it("maps stale transport errors to Cogito brief unavailable", async () => {
    const registry = createRegistry();
    registerNode(registry);
    const bridge: LiveCogitoCommandBridge = {
      sendPendingCommand: async () => {
        throw new NodeCommandTransportError({
          code: "TRANSPORT_STALE",
          nodeId: node.id,
          connectionId: "stale-connection",
          message: "Node transport is stale",
        });
      },
    };
    const collector = createLiveCogitoBriefCollector({ registry, bridge });

    await expect(collector.reflectBrief(node, 5)).rejects.toBeInstanceOf(
      CogitoBriefUnavailableError,
    );
  });

  it("maps pending command timeout to Cogito brief timeout", async () => {
    const registry = createRegistry();
    registerNode(registry);
    const bridge: LiveCogitoCommandBridge = {
      sendPendingCommand: async (routed) => {
        throw new PendingNodeCommandTimeoutError({
          commandType: "reflect_brief",
          requestId: routed.command.requestId,
          timeoutMs: routed.command.timeoutMs,
        });
      },
    };
    const collector = createLiveCogitoBriefCollector({ registry, bridge });

    await expect(collector.reflectBrief(node, 3.5)).rejects.toBeInstanceOf(
      CogitoBriefTimeoutError,
    );
  });

  it("keeps non-disconnect command errors available for aggregate node_error handling", async () => {
    const registry = createRegistry();
    registerNode(registry);
    const bridge: LiveCogitoCommandBridge = {
      sendPendingCommand: async (routed) => {
        throw new PendingNodeCommandRejectedError({
          commandType: "reflect_brief",
          requestId: routed.command.requestId,
          message: "reflection runtime is not configured",
          response: {
            type: "error",
            requestId: routed.command.requestId,
            message: "reflection runtime is not configured",
          },
        });
      },
    };
    const collector = createLiveCogitoBriefCollector({ registry, bridge });

    await expect(collector.reflectBrief(node, 5)).rejects.toBeInstanceOf(
      PendingNodeCommandRejectedError,
    );
  });
});

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType, nowMs }) =>
      `brief-${commandType}-${sequence}-${nowMs}`,
  });
}

function registerNode(registry: InMemoryNodeRegistry): string {
  return registry.registerNode({
    type: "node_register",
    node_id: node.id,
    host: node.host,
    port: node.port,
    capabilities: node.capabilities,
  }).node.connectionId;
}
