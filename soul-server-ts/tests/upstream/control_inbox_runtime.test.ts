import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlInboxRuntime,
  type ControlInboxDispatchWork,
  type ControlInboxStorage,
} from "../../src/upstream/control_inbox_runtime.js";
import { ControlInboxStore } from "../../src/upstream/control_inbox_store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<ControlInboxStore> {
  const root = await mkdtemp(join(tmpdir(), "control-runtime-"));
  roots.push(root);
  return new ControlInboxStore({
    databasePath: join(root, "_control", "control-inbox.sqlite"),
    nodeId: "node-a",
    hostGeneration: "host-a",
  });
}

describe("ControlInboxRuntime", () => {
  it("sends accepted only after the durable receipt commit and before domain execution", async () => {
    const sequence: string[] = [];
    const store = await makeStore();
    const originalAdmit = store.admit.bind(store);
    store.admit = ((...args: Parameters<typeof store.admit>) => {
      const result = originalAdmit(...args);
      sequence.push("commit");
      return result;
    }) as typeof store.admit;
    const work: ControlInboxDispatchWork[] = [];
    const runtime = new ControlInboxRuntime({
      store,
      nodeId: "node-a",
      mainHeartbeatAgeMs: () => 0,
      postWork: (item) => {
        sequence.push("post-work");
        work.push(item);
      },
    });
    runtime.initialize();
    await runtime.connect(async (frame) => {
      if (frame.type === "control_admission_ack") sequence.push("accepted");
    });

    await runtime.handleCommand({
      type: "intervene",
      requestId: "req-1",
      agentSessionId: "session-a",
      text: "hello",
    });

    expect(sequence.slice(0, 3)).toEqual(["commit", "accepted", "post-work"]);
    expect(work).toEqual([
      expect.objectContaining({
        durable: true,
        command: expect.objectContaining({ type: "intervene" }),
      }),
    ]);
    store.close();
  });

  it("returns rejected/degraded and never accepted when storage fails", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const postWork = vi.fn();
    const store = failingStorage(new Error("disk unavailable"));
    const runtime = new ControlInboxRuntime({
      store,
      nodeId: "node-a",
      mainHeartbeatAgeMs: () => 0,
      postWork,
    });
    runtime.initialize();
    await runtime.connect(async (frame) => {
      frames.push(frame);
    });

    await runtime.handleCommand({
      type: "interrupt_session",
      requestId: "req-storage",
      agentSessionId: "session-a",
    });

    expect(frames).toContainEqual(expect.objectContaining({
      type: "error",
      requestId: "req-storage",
      status: "rejected",
      code: "CONTROL_INBOX_DEGRADED",
    }));
    expect(frames).not.toContainEqual(expect.objectContaining({ status: "accepted" }));
    expect(postWork).not.toHaveBeenCalled();
  });

  it("times out bounded queries without presenting admission as success", async () => {
    vi.useFakeTimers();
    const frames: Array<Record<string, unknown>> = [];
    const store = await makeStore();
    const runtime = new ControlInboxRuntime({
      store,
      nodeId: "node-a",
      mainHeartbeatAgeMs: () => 0,
      postWork: () => undefined,
      boundedResultTimeoutMs: 1_000,
    });
    runtime.initialize();
    await runtime.connect(async (frame) => {
      frames.push(frame);
    });

    await runtime.handleCommand({ type: "provider_usage_get", requestId: "req-query" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(frames).toContainEqual(expect.objectContaining({
      type: "error",
      requestId: "req-query",
      status: "degraded",
      code: "CONTROL_RESULT_TIMEOUT",
    }));
    expect(frames).not.toContainEqual(expect.objectContaining({ status: "accepted" }));
    store.close();
  });

  it("uses main heartbeat freshness for health while stalled mutations remain admitted", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const work: ControlInboxDispatchWork[] = [];
    const store = await makeStore();
    const runtime = new ControlInboxRuntime({
      store,
      nodeId: "node-a",
      mainHeartbeatAgeMs: () => 1_500,
      postWork: (item) => work.push(item),
    });
    runtime.initialize();
    await runtime.connect(async (frame) => {
      frames.push(frame);
    });

    await Promise.all([
      runtime.handleCommand({
        type: "intervene",
        requestId: "req-intervene",
        agentSessionId: "session-a",
        text: "hello",
      }),
      runtime.handleCommand({
        type: "interrupt_session",
        requestId: "req-cancel",
        agentSessionId: "session-a",
      }),
      runtime.handleCommand({ type: "health_check", requestId: "req-health" }),
    ]);

    expect(frames).toContainEqual(expect.objectContaining({
      type: "control_admission_ack",
      requestId: "req-intervene",
      status: "accepted",
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "control_admission_ack",
      requestId: "req-cancel",
      status: "accepted",
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "health_status",
      requestId: "req-health",
      status: "unavailable",
      mainHeartbeatAgeMs: 1_500,
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "control_ack_metric",
      commandFamily: "health",
      windowMs: 5 * 60_000,
      sampleCount: 1,
      p99Ms: null,
      maxGateMs: 1_000,
      withinGate: true,
    }));
    expect(work).toHaveLength(2);
    store.close();
  });

  it("drains every startup inbox page instead of stranding receipts after the first 100", async () => {
    const store = await makeStore();
    store.initialize();
    for (let index = 0; index < 101; index += 1) {
      store.admit("intervention", {
        type: "intervene",
        requestId: `req-${index}`,
        agentSessionId: "session-a",
        text: "stop",
      });
    }
    const work: ControlInboxDispatchWork[] = [];
    const runtime = new ControlInboxRuntime({
      store,
      nodeId: "node-a",
      mainHeartbeatAgeMs: () => 0,
      postWork: (item) => work.push(item),
    });

    await runtime.connect(async () => undefined);

    expect(work).toHaveLength(101);
    store.close();
  });

  it("dispatches a committed mutation even when the ride-along metric send fails", async () => {
    const store = await makeStore();
    const work: ControlInboxDispatchWork[] = [];
    const runtime = new ControlInboxRuntime({
      store,
      nodeId: "node-a",
      mainHeartbeatAgeMs: () => 0,
      postWork: (item) => work.push(item),
    });
    runtime.initialize();
    await runtime.connect(async (frame) => {
      if (frame.type === "control_ack_metric") throw new Error("metric send failed");
    });

    await runtime.handleCommand({
      type: "intervene",
      requestId: "req-metric-failure",
      agentSessionId: "session-a",
      text: "stop",
    });

    expect(work).toHaveLength(1);
    store.close();
  });
});

function failingStorage(error: Error): ControlInboxStorage {
  return {
    initialize: () => ({ reclaimed: 0, pending: 0, replayableResults: 0 }),
    admit: () => {
      throw error;
    },
    claimPending: () => [],
    complete: () => {
      throw new Error("unexpected complete");
    },
    listReplayableResults: () => [],
    acknowledgeResult: () => false,
    close: () => undefined,
  };
}
