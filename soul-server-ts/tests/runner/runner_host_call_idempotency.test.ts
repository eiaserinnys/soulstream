import { describe, expect, it, vi } from "vitest";

import {
  RunnerHostCallIdempotency,
  isMutatingRunnerHostCall,
  type RunnerHostCallReceiptStore,
} from "../../src/runner/runner_host_call_idempotency.js";

describe("RunnerHostCallIdempotency", () => {
  it("reports parent-owned receipt cleanup failures to its caller", async () => {
    const failure = new Error("runner host receipt store corrupt");
    const store = memoryReceiptStore();
    vi.spyOn(store, "acknowledgeHostCall").mockRejectedValueOnce(failure);
    const host = new RunnerHostCallIdempotency(store);

    await expect(host.acknowledge("host:cleanup-corrupt")).rejects.toBe(failure);
  });

  it("retries through the durable owner after apply committed but host receipt was not recorded", async () => {
    const firstStore = memoryReceiptStore();
    const secondStore = memoryReceiptStore();
    const firstHost = new RunnerHostCallIdempotency(firstStore);
    const secondHost = new RunnerHostCallIdempotency(secondStore);
    const ownerReceipts = new Set<string>();
    let applications = 0;
    const apply = vi.fn(async (idempotencyKey: string) => {
      expect(idempotencyKey).toBe("host:mutation-one");
      if (!ownerReceipts.has(idempotencyKey)) {
        applications += 1;
        ownerReceipts.add(idempotencyKey);
      }
      return null;
    });
    const call = {
      correlationId: "host:mutation-one",
      service: "snapshot" as const,
      operation: "persistRunState",
      args: ["session-a", { backendId: "openai-agents" }],
    };

    vi.spyOn(firstStore, "recordHostCallApplied")
      .mockRejectedValueOnce(new Error("host died before local receipt"));
    // The durable owner committed, then the host died before the runner-local
    // receipt. A new host must retry the owner with the same correlation key.
    await expect(firstHost.execute(call, apply)).rejects.toThrow(
      "host died before local receipt",
    );
    await expect(secondHost.execute(call, apply)).resolves.toEqual({
      data: null,
      replayed: false,
    });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(applications).toBe(1);
    await secondHost.acknowledge(call.correlationId);
    await expect(firstStore.readHostCallApplied(call.correlationId)).resolves.toBeNull();
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

function memoryReceiptStore(): RunnerHostCallReceiptStore {
  const receipts = new Map<string, {
    correlationId: string;
    service: string;
    operation: string;
  }>();
  return {
    readHostCallApplied: async (correlationId) => receipts.get(correlationId) ?? null,
    recordHostCallApplied: async (input) => {
      receipts.set(input.correlationId, input);
    },
    acknowledgeHostCall: async (correlationId) => {
      receipts.delete(correlationId);
    },
  };
}
