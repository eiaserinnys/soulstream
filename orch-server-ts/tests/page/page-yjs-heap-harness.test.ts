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
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );
    const result = JSON.parse(output.trim().split("\n").at(-1)!) as {
      edits: number;
      storeCalls: number;
      maxQueuedDeltaBytes: number;
      retainedSlopeBytes: number;
    };

    expect(result.edits).toBe(3_000);
    expect(result.storeCalls).toBeLessThanOrEqual(4);
    expect(result.maxQueuedDeltaBytes).toBeLessThan(64 * 1024 * 1024);
    expect(result.retainedSlopeBytes).toBeLessThan(16 * 1024 * 1024);
  }, 35_000);
});
