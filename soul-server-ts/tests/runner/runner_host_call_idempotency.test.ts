import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunnerHostCallIdempotency,
  isMutatingRunnerHostCall,
} from "../../src/runner/runner_host_call_idempotency.js";
import { RunnerSqliteEventOutbox } from "../../src/runner/sqlite_event_outbox.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("RunnerHostCallIdempotency", () => {
  it("does not reapply a mutation when a new host retries after the response was lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-host-call-"));
    directories.push(directory);
    const path = join(directory, "runner.sqlite");
    const firstStore = await RunnerSqliteEventOutbox.open(path);
    const secondStore = await RunnerSqliteEventOutbox.open(path);
    const firstHost = new RunnerHostCallIdempotency(firstStore);
    const secondHost = new RunnerHostCallIdempotency(secondStore);
    const apply = vi.fn(async () => null);
    const call = {
      correlationId: "host:mutation-one",
      service: "snapshot" as const,
      operation: "persistRunState",
      args: ["session-a", { backendId: "openai-agents" }],
    };

    await expect(firstHost.execute(call, apply)).resolves.toEqual({
      data: null,
      replayed: false,
    });
    // The first host applied and journaled the mutation, then its response was lost.
    await expect(secondHost.execute(call, apply)).resolves.toEqual({
      data: null,
      replayed: true,
    });

    expect(apply).toHaveBeenCalledOnce();
    await secondHost.acknowledge(call.correlationId);
    await expect(firstStore.readHostCallApplied(call.correlationId)).resolves.toBeNull();
    firstStore.close();
    secondStore.close();
  });

  it("enumerates mutating and read-only host operations without an implicit fallback", () => {
    expect(isMutatingRunnerHostCall("session_store", "append")).toBe(true);
    expect(isMutatingRunnerHostCall("session_store", "delete")).toBe(true);
    expect(isMutatingRunnerHostCall("session_store", "load")).toBe(false);
    expect(isMutatingRunnerHostCall("session_store", "listSessions")).toBe(false);
    expect(isMutatingRunnerHostCall("session_store", "listSubkeys")).toBe(false);
    expect(isMutatingRunnerHostCall("snapshot", "persistRunState")).toBe(true);
    expect(isMutatingRunnerHostCall("snapshot", "persistSessionItems")).toBe(true);
    expect(isMutatingRunnerHostCall("claude_runtime", "observe")).toBe(true);
    expect(isMutatingRunnerHostCall("detached_event", "publish")).toBe(true);
    expect(() => isMutatingRunnerHostCall("snapshot", "unknown"))
      .toThrow("unsupported runner host call inventory");
  });
});
