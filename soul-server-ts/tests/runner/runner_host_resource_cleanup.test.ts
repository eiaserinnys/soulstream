import { describe, expect, it, vi } from "vitest";

import {
  releaseRunnerHostResources,
} from "../../src/runner/runner_host_resource_cleanup.js";

describe("releaseRunnerHostResources", () => {
  it("releases every host-owned resource in declaration order", async () => {
    const order: string[] = [];

    await releaseRunnerHostResources([
      { name: "observation", run: () => { order.push("observation"); } },
      { name: "connection", run: async () => { order.push("connection"); } },
      { name: "writer lock", run: () => { order.push("writer lock"); } },
    ]);

    expect(order).toEqual(["observation", "connection", "writer lock"]);
  });

  it("attempts later releases after both synchronous and asynchronous failures", async () => {
    const last = vi.fn();

    const release = releaseRunnerHostResources([
      { name: "sync", run: () => { throw new Error("sync failed"); } },
      { name: "async", run: async () => { throw new Error("async failed"); } },
      { name: "last", run: last },
    ]);

    await expect(release).rejects.toMatchObject({
      message: "runner host resource cleanup failed",
      errors: [
        expect.objectContaining({ message: "runner host cleanup failed: sync" }),
        expect.objectContaining({ message: "runner host cleanup failed: async" }),
      ],
    });
    expect(last).toHaveBeenCalledOnce();
  });

  it("preserves each cleanup failure as the named aggregate cause", async () => {
    const first = new Error("first failure");

    try {
      await releaseRunnerHostResources([
        { name: "first", run: () => { throw first; } },
        { name: "second", run: () => { throw "second failure"; } },
      ]);
      throw new Error("expected cleanup to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const failures = (error as AggregateError).errors as Error[];
      expect(failures.map((failure) => failure.message)).toEqual([
        "runner host cleanup failed: first",
        "runner host cleanup failed: second",
      ]);
      expect(failures[0]?.cause).toBe(first);
      expect(failures[1]?.cause).toMatchObject({ message: "second failure" });
    }
  });

  it("treats an empty resource set as already released", async () => {
    await expect(releaseRunnerHostResources([])).resolves.toBeUndefined();
  });
});
