import { describe, expect, it, vi } from "vitest";

import { MemoryStatsCollector } from "../src/index.js";

describe("MemoryStatsCollector", () => {
  it("keeps periodic summaries cheap and computes details only on demand", () => {
    const details = vi.fn(() => ({ listeners: 3, catalog_updated: 2 }));
    const approxBytes = vi.fn(() => 12_345);
    const collector = new MemoryStatsCollector({
      nowIso: () => "2026-07-27T08:00:00.000Z",
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
    });
    collector.registerSource({
      name: "session_replay_ring",
      entries: () => 7,
      details,
      approxBytes,
    });

    expect(collector.summary()).toEqual({
      measuredAt: "2026-07-27T08:00:00.000Z",
      rss: 900,
      heapUsed: 500,
      heapSizeLimit: 2_000,
      components: { session_replay_ring: 7 },
    });
    expect(details).not.toHaveBeenCalled();
    expect(approxBytes).not.toHaveBeenCalled();

    expect(collector.collect()).toEqual({
      measuredAt: "2026-07-27T08:00:00.000Z",
      process: {
        rss: 900,
        heapTotal: 700,
        heapUsed: 500,
        external: 100,
        arrayBuffers: 50,
      },
      v8: {
        heapSizeLimit: 2_000,
        totalHeapSize: 700,
        totalAvailableSize: 1_300,
        usedHeapSize: 500,
        mallocedMemory: 25,
        externalMemory: 100,
      },
      components: {
        session_replay_ring: {
          entries: 7,
          details: { listeners: 3, catalog_updated: 2 },
          approxBytes: 12_345,
        },
      },
    });
    expect(details).toHaveBeenCalledTimes(1);
    expect(approxBytes).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate component source names", () => {
    const collector = new MemoryStatsCollector();
    collector.registerSource({ name: "cache", entries: () => 1 });

    expect(() =>
      collector.registerSource({ name: "cache", entries: () => 2 })
    ).toThrow("Duplicate memory stats source: cache");
  });
});
