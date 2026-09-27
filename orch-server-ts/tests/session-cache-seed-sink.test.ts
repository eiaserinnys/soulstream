import { describe, expect, it, vi } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import { createSessionCacheSeedSink } from "../src/node/session_cache_seed_sink.js";

describe("createSessionCacheSeedSink", () => {
  it("pages the orch DB snapshot and seeds the connected node cache", async () => {
    const registry = new InMemoryNodeRegistry();
    const registered = registry.registerNode({ type: "node_register", node_id: "node-a" });
    const listSessionSnapshots = vi.fn(async ({ offset }: { offset: number }) => ({
      sessions: offset === 0
        ? [{ agent_session_id: "session-a", status: "running" }]
        : [{ agent_session_id: "session-b", status: "completed" }],
      sessionList: [],
      total: 2,
      cursor: null,
      nextCursor: null,
      hasMore: offset === 0,
    }));
    const onNodeReady = vi.fn((nodeId: string, connectionId: string) => {
      expect(registry.getConnectedNode(nodeId)?.connectionId).toBe(connectionId);
      expect(registry.sessionCache.getSessionsForNode(nodeId)).toHaveLength(2);
    });
    const sink = createSessionCacheSeedSink({
      registry,
      repository: { listSessionSnapshots },
      logError: vi.fn(),
      onNodeReady,
      pageSize: 1,
      nowMs: () => 100,
    });

    sink([registered.event]);

    await vi.waitFor(() => expect(registry.sessionCache.getSessionsForNode("node-a"))
      .toHaveLength(2));
    expect(listSessionSnapshots).toHaveBeenNthCalledWith(1, {
      nodeId: "node-a",
      offset: 0,
      limit: 1,
    });
    expect(listSessionSnapshots).toHaveBeenNthCalledWith(2, {
      nodeId: "node-a",
      offset: 1,
      limit: 1,
    });
    expect(onNodeReady).toHaveBeenCalledTimes(1);
    expect(onNodeReady).toHaveBeenCalledWith(
      "node-a",
      registered.node.connectionId,
    );
  });

  it("discards a stale DB result after a newer node connection replaces it", async () => {
    const registry = new InMemoryNodeRegistry();
    const first = registry.registerNode({ type: "node_register", node_id: "node-a" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onNodeReady = vi.fn();
    const sink = createSessionCacheSeedSink({
      registry,
      repository: {
        listSessionSnapshots: async () => {
          await pending;
          return {
            sessions: [{ agent_session_id: "stale-session", status: "running" }],
            sessionList: [],
            total: 1,
            cursor: null,
            nextCursor: null,
            hasMore: false,
          };
        },
      },
      logError: vi.fn(),
      onNodeReady,
    });

    sink([first.event]);
    registry.registerNode({ type: "node_register", node_id: "node-a" });
    release();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.sessionCache.findSession("stale-session")).toBeUndefined();
    expect(onNodeReady).not.toHaveBeenCalled();
  });

  it("seeds over a disconnected old connection when disconnect and snapshot start share a millisecond", async () => {
    let nowMs = 100;
    const registry = new InMemoryNodeRegistry({ nowMs: () => nowMs });
    const first = registry.registerNode({ type: "node_register", node_id: "node-a" });
    registry.sessionCache.replaceNodeSessions({
      nodeId: "node-a",
      connectionId: first.node.connectionId,
      sessions: [{ agent_session_id: "session-a", status: "running" }],
      nowMs,
    });

    nowMs = 200;
    const replacement = registry.registerNode({
      type: "node_register",
      node_id: "node-a",
    });
    const sink = createSessionCacheSeedSink({
      registry,
      repository: {
        listSessionSnapshots: async () => ({
          sessions: [{ agent_session_id: "session-a", status: "interrupted" }],
          sessionList: [],
          total: 1,
          cursor: null,
          nextCursor: null,
          hasMore: false,
        }),
      },
      logError: vi.fn(),
      nowMs: () => nowMs,
    });

    sink([replacement.event]);
    await vi.waitFor(() => expect(registry.sessionCache.findSession("session-a"))
      .toMatchObject({
        connectionId: replacement.node.connectionId,
        fresh: true,
        status: "interrupted",
      }));
  });
});
