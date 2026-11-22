import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("Page Yjs retained heap gate", () => {
  it("keeps 3,000 real-provider edits within the bounded store and heap caps", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "scripts/page-yjs-heap-harness.ts",
        "--assert-stable",
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 38_000 },
    );
    const result = JSON.parse(output.trim().split("\n").at(-1)!) as {
      edits: number;
      storeCalls: number;
      maxQueuedDeltaBytes: number;
      retainedSlopeBytes: number;
      samples: Array<{ round: number; storedEdits: number; unsyncedChanges: boolean }>;
    };

    expect(result.edits).toBe(3_000);
    expect(result.samples.map(({ round, storedEdits, unsyncedChanges }) => ({
      round, storedEdits, unsyncedChanges,
    }))).toEqual([
      { round: 1, storedEdits: 1_000, unsyncedChanges: false },
      { round: 2, storedEdits: 2_000, unsyncedChanges: false },
      { round: 3, storedEdits: 3_000, unsyncedChanges: false },
    ]);
    expect(result.storeCalls).toBeLessThanOrEqual(4);
    expect(result.maxQueuedDeltaBytes).toBeLessThan(64 * 1024 * 1024);
    expect(result.retainedSlopeBytes).toBeLessThan(16 * 1024 * 1024);
  }, 39_000);
});
