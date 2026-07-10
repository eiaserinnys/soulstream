import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveAttachmentRouteProviders,
  type NodeConnectionSnapshot,
} from "../src/index.js";

const connectedNode: NodeConnectionSnapshot = {
  nodeId: "node-attachment",
  connectionId: "conn-attachment",
  host: "127.0.0.1",
  port: 4105,
  agents: [],
  capabilities: {},
  supportedBackends: ["codex"],
  connected: true,
  status: "connected",
  connectedAtMs: 1_700_000_000_000,
  disconnectedAtMs: undefined,
  lastSeenAtMs: 1_700_000_000_000,
  heartbeat: {
    supported: false,
    timeoutMs: 30_000,
    lastPingAtMs: undefined,
    lastPongAtMs: undefined,
  },
  pendingCommandCount: 0,
};

describe("live attachment route providers", () => {
  it("maps Python NodeManager.get_node semantics to the connected runtime registry", async () => {
    const getConnectedNode = vi.fn((nodeId: string) =>
      nodeId === connectedNode.nodeId ? connectedNode : undefined
    );
    const providers = createLiveAttachmentRouteProviders({
      registry: { getConnectedNode },
      dashboardAccessProvider: {
        resolveAccess: vi.fn(async () => ({
          restricted: false,
          allowedFolderIds: [],
        })),
      },
      sessionResourceAccessProvider: {
        requireSessionAccess: vi.fn(async () => undefined),
      },
    });

    await expect(providers.provider.getNode("node-attachment")).resolves.toBe(
      connectedNode,
    );
    await expect(providers.provider.getNode("missing-node")).resolves.toBeNull();
    expect(getConnectedNode).toHaveBeenNthCalledWith(1, "node-attachment");
    expect(getConnectedNode).toHaveBeenNthCalledWith(2, "missing-node");
  });

  it("reuses the shared dashboard and session access functions without a second policy", async () => {
    const resolveAccess = vi.fn(async () => ({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    }));
    const requireSessionAccess = vi.fn(async () => undefined);
    const providers = createLiveAttachmentRouteProviders({
      registry: { getConnectedNode: vi.fn(() => undefined) },
      dashboardAccessProvider: { resolveAccess },
      sessionResourceAccessProvider: { requireSessionAccess },
    });
    const request = { headers: {} } as FastifyRequest;

    expect(providers.accessProvider.resolveAccess).toBe(resolveAccess);
    expect(providers.accessProvider.requireSessionAccess).toBe(requireSessionAccess);
    await expect(
      providers.accessProvider.resolveAccess(request, {
        accessEmail: "reader@example.com",
      }),
    ).resolves.toMatchObject({ restricted: true });
    await providers.accessProvider.requireSessionAccess({
      request,
      sessionId: "session-a",
      accessEmail: "reader@example.com",
    });
    expect(resolveAccess).toHaveBeenCalledWith(request, {
      accessEmail: "reader@example.com",
    });
    expect(requireSessionAccess).toHaveBeenCalledWith({
      request,
      sessionId: "session-a",
      accessEmail: "reader@example.com",
    });
  });
});
