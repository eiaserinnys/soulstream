import { describe, expect, it } from "vitest";

import {
  parseNodeResourceSnapshot,
  type NodeResourceSnapshot,
} from "../src/node_resources.ts";

const snapshot: NodeResourceSnapshot = {
  collectedAt: "2026-10-22T03:00:00.000Z",
  cpu: { usagePercent: 14.2, cores: 8, loadAvg1m: 0.48 },
  memory: {
    usagePercent: 62.5,
    usedBytes: 5_000,
    availableBytes: 3_000,
    totalBytes: 8_000,
  },
  disk: {
    path: "/",
    usagePercent: 75,
    usedBytes: 6_000,
    availableBytes: 2_000,
    totalBytes: 8_000,
  },
  diskQueue: {
    device: "nvme0n1",
    inFlight: 1,
    avgQueueDepth: 0.4,
    busyPercent: 2.5,
  },
};

describe("NodeResourceSnapshot wire parser", () => {
  it("returns a normalized resource snapshot", () => {
    expect(parseNodeResourceSnapshot({ ...snapshot, ignored: true })).toEqual(snapshot);
  });

  it("accepts null disk measurements", () => {
    expect(parseNodeResourceSnapshot({
      ...snapshot,
      disk: null,
      diskQueue: null,
    })).toMatchObject({ disk: null, diskQueue: null });
  });

  it("rejects snapshots with missing or non-finite measurements", () => {
    expect(parseNodeResourceSnapshot(null)).toBeUndefined();
    expect(parseNodeResourceSnapshot({ ...snapshot, cpu: { ...snapshot.cpu, cores: NaN } }))
      .toBeUndefined();
    expect(parseNodeResourceSnapshot({ ...snapshot, memory: { ...snapshot.memory, usedBytes: "5" } }))
      .toBeUndefined();
  });
});
