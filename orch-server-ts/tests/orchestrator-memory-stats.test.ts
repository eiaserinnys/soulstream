import { describe, expect, it, vi } from "vitest";

import { createOrchestratorMemoryStatsCollector } from "../src/index.js";

describe("createOrchestratorMemoryStatsCollector", () => {
  it("registers every retained runtime component and defers ring sizing", () => {
    const approxBytes = vi.fn(() => 6_000_000);
    const collector = createOrchestratorMemoryStatsCollector({
      sessionBroadcaster: {
        getStats: () => ({ bufferedEvents: 8, listeners: 2 }),
        getTypeCounts: () => ({ catalog_updated: 6, session_updated: 2 }),
        approxBytes,
      },
      sessionCache: {
        getStats: () => ({ nodes: 3, sessions: 12 }),
      },
      registry: {
        getStats: () => ({
          nodes: 3,
          connectedNodes: 2,
          pendingCommands: 4,
        }),
      },
      pushNotifier: {
        getStats: () => ({
          toolInputs: 6,
          notificationEvents: 2,
          pendingSends: 1,
        }),
      },
      foregroundObservers: {
        getStats: () => ({ sessions: 2, observers: 3 }),
      },
      boardYjsDocuments: () => 9,
      pageYjsDocuments: () => 10,
      collectorOptions: {
        memoryUsage: () => ({
          rss: 900,
          heapTotal: 700,
          heapUsed: 500,
          external: 100,
          arrayBuffers: 50,
        }),
        heapStatistics: () => ({
          heap_size_limit: 2_000,
          total_heap_size: 700,
          total_available_size: 1_300,
          used_heap_size: 500,
          malloced_memory: 25,
          external_memory: 100,
        }),
      },
    });

    expect(collector.summary().components).toEqual({
      session_replay_ring: 8,
      session_cache: 12,
      pending_commands: 4,
      push_notifier: 9,
      foreground_observers: 3,
      board_yjs_documents: 9,
      page_yjs_documents: 10,
    });
    expect(approxBytes).not.toHaveBeenCalled();

    expect(collector.collect().components).toMatchObject({
      session_replay_ring: {
        entries: 8,
        details: {
          listeners: 2,
          catalog_updated: 6,
          session_updated: 2,
        },
        approxBytes: 6_000_000,
      },
      session_cache: { entries: 12, details: { nodes: 3 } },
      pending_commands: {
        entries: 4,
        details: { nodes: 3, connectedNodes: 2 },
      },
      push_notifier: {
        entries: 9,
        details: { toolInputs: 6, notificationEvents: 2, pendingSends: 1 },
      },
      foreground_observers: {
        entries: 3,
        details: { sessions: 2 },
      },
      board_yjs_documents: { entries: 9 },
      page_yjs_documents: { entries: 10 },
    });
    expect(approxBytes).toHaveBeenCalledTimes(1);
  });
});
