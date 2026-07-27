import { describe, expect, it } from "vitest";

import {
  DISCONNECTED_SESSION_CACHE_TTL_MS,
  PerNodeSessionCache,
  TERMINAL_SESSION_CACHE_TTL_MS,
} from "../src/index.js";

describe("PerNodeSessionCache retention", () => {
  it("keeps terminal enrichment during the grace window then removes both indexes", () => {
    const cache = new PerNodeSessionCache();
    cache.upsertFromSessionUpdated({
      nodeId: "node-a",
      connectionId: "connection-a",
      message: {
        agent_session_id: "session-a",
        status: "completed",
        display_name: "Finished session",
      },
      nowMs: 1_000,
    });

    expect(cache.sweepExpired(1_000 + TERMINAL_SESSION_CACHE_TTL_MS - 1))
      .toEqual({ terminalSessions: 0, disconnectedSessions: 0, total: 0 });
    cache.upsertFromEventRelay({
      nodeId: "node-a",
      connectionId: "connection-a",
      message: {
        type: "event",
        agentSessionId: "session-a",
        event: { id: 42, type: "assistant_message" },
      },
      nowMs: 1_000 + TERMINAL_SESSION_CACHE_TTL_MS - 1,
    });
    expect(cache.findSession("session-a")).toMatchObject({
      status: "completed",
      lastEventId: 42,
    });

    expect(cache.sweepExpired(1_000 + 2 * TERMINAL_SESSION_CACHE_TTL_MS))
      .toEqual({ terminalSessions: 1, disconnectedSessions: 0, total: 1 });
    expect(cache.findSession("session-a")).toBeUndefined();
    expect(cache.getSessionsForNode("node-a")).toEqual([]);
    expect(cache.getStats()).toEqual({ nodes: 0, sessions: 0 });
  });

  it("removes disconnected sessions only after the 24 hour retention window", () => {
    const cache = new PerNodeSessionCache();
    cache.replaceNodeSessions({
      nodeId: "node-a",
      connectionId: "connection-a",
      sessions: [{ agentSessionId: "session-a", status: "running" }],
      nowMs: 1_000,
    });
    cache.markNodeDisconnected("node-a", 2_000);

    expect(cache.sweepExpired(2_000 + DISCONNECTED_SESSION_CACHE_TTL_MS - 1).total)
      .toBe(0);
    expect(cache.sweepExpired(2_000 + DISCONNECTED_SESSION_CACHE_TTL_MS))
      .toEqual({ terminalSessions: 0, disconnectedSessions: 1, total: 1 });
    expect(cache.getStats()).toEqual({ nodes: 0, sessions: 0 });
  });

  it("projects repeated updates onto a bounded serialization payload whitelist", () => {
    const cache = new PerNodeSessionCache();
    for (let index = 0; index < 100; index += 1) {
      cache.upsertFromSessionUpdated({
        nodeId: "node-a",
        connectionId: "connection-a",
        message: {
          agent_session_id: "session-a",
          status: "running",
          display_name: `Session ${index}`,
          caller_source: "browser",
          [`unknown_${index}`]: "x".repeat(1_000),
        },
        nowMs: index,
      });
    }

    const session = cache.findSession("session-a");
    expect(session?.payload).toMatchObject({
      agent_session_id: "session-a",
      status: "running",
      display_name: "Session 99",
      caller_source: "browser",
    });
    expect(Object.keys(session?.payload ?? {}).some((key) => key.startsWith("unknown_")))
      .toBe(false);
    expect(JSON.stringify(session?.payload).length).toBeLessThan(300);
    expect(cache.getStats()).toEqual({ nodes: 1, sessions: 1 });
  });
});
