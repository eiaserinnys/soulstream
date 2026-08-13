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
    const sink = createSessionCacheSeedSink({
      registry,
      repository: { listSessionSnapshots },
      logError: vi.fn(),
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
  });

  it("discards a stale DB result after a newer node connection replaces it", async () => {
    const registry = new InMemoryNodeRegistry();
    const first = registry.registerNode({ type: "node_register", node_id: "node-a" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    });

    sink([first.event]);
    registry.registerNode({ type: "node_register", node_id: "node-a" });
    release();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.sessionCache.findSession("stale-session")).toBeUndefined();
  });
});
