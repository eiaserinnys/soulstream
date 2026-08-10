import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionReconciliationSink } from
  "../src/node/session_reconciliation_sink.js";

describe("createSessionReconciliationSink", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes disconnect before startup reconciliation for the same node", async () => {
    const order: string[] = [];
    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const repository = {
      reconcileNodeDisconnected: vi.fn(async (_nodeId, _at, detail) => {
        expect(detail).toBe("node_disconnect");
        order.push("disconnect-start");
        await disconnectGate;
        order.push("disconnect-end");
        return 1;
      }),
      reconcileNodeStartup: vi.fn(async (_nodeId, sessionIds) => {
        order.push(`startup:${sessionIds.join(",")}`);
        return { interrupted: 0, restored: 1 };
      }),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });

    sink([
      { type: "node_unregistered", nodeId: "node-a" } as never,
      {
        type: "node_session_sessions_update",
        nodeId: "node-a",
        data: { running_session_ids: ["session-live"] },
      },
    ]);
    await vi.waitFor(() => expect(order).toEqual(["disconnect-start"]));
    releaseDisconnect();
    await vi.waitFor(() =>
      expect(order).toEqual([
        "disconnect-start",
        "disconnect-end",
        "startup:session-live",
      ]),
    );
  });

  it("logs reconciliation rejection and keeps the next operation runnable", async () => {
    const logError = vi.fn();
    const reconcileNodeDisconnected = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(0);
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => ({
        reconcileNodeDisconnected,
        reconcileNodeStartup: vi.fn(),
      }),
      logError,
    });

    sink([{ type: "node_unregistered", nodeId: "node-a" } as never]);
    sink([{ type: "node_unregistered", nodeId: "node-a" } as never]);

    await vi.waitFor(() => expect(reconcileNodeDisconnected).toHaveBeenCalledTimes(2));
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "database unavailable" }),
      "session reconciliation failed for node-a",
    );
  });

  it("defers disconnect until the runner lease window expires and records an explicit timeout", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-11T00:00:00.000Z");
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      now: () => now,
      leaseAware: true,
      disconnectGraceMs: 120_000,
    });

    sink([disconnectEvent("connection-a")]);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledWith(
      "node-a",
      now,
      "node_disconnect_timeout",
    );
  });

  it("cancels the deferred kill only after a valid reconnect inventory arrives", async () => {
    vi.useFakeTimers();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 2 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      leaseAware: true,
      disconnectGraceMs: 120_000,
    });

    sink([disconnectEvent("connection-a")]);
    sink([{
      type: "node_session_sessions_update",
      nodeId: "node-a",
      data: { running_session_ids: ["session-memory", "session-runner"] },
    }]);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();
    expect(repository.reconcileNodeStartup).toHaveBeenCalledWith(
      "node-a",
      ["session-memory", "session-runner"],
      expect.any(Date),
    );
  });

  it("keeps the grace deadline when reconnect inventory is malformed", async () => {
    vi.useFakeTimers();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      leaseAware: true,
      disconnectGraceMs: 10,
    });

    sink([disconnectEvent("connection-a")]);
    sink([{
      type: "node_session_sessions_update",
      nodeId: "node-a",
      data: { running_session_ids: [42] },
    }]);
    await vi.advanceTimersByTimeAsync(10);

    expect(repository.reconcileNodeStartup).not.toHaveBeenCalled();
    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledWith(
      "node-a",
      expect.any(Date),
      "node_disconnect_timeout",
    );
  });

  it("replaces an older connection deadline instead of letting it kill the new connection", async () => {
    vi.useFakeTimers();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      leaseAware: true,
      disconnectGraceMs: 10,
    });

    sink([disconnectEvent("connection-a")]);
    await vi.advanceTimersByTimeAsync(5);
    sink([disconnectEvent("connection-b")]);
    await vi.advanceTimersByTimeAsync(5);
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);
    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledOnce();
  });

  it("invalidates an expired queued timeout when reconnect wins before the mutation begins", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn()
        .mockImplementationOnce(async () => await first)
        .mockResolvedValue({ interrupted: 0, restored: 1 }),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      leaseAware: true,
      disconnectGraceMs: 10,
    });

    sink([{
      type: "node_session_sessions_update",
      nodeId: "node-a",
      data: { running_session_ids: ["session-old"] },
    }]);
    await vi.advanceTimersByTimeAsync(0);
    sink([disconnectEvent("connection-a")]);
    await vi.advanceTimersByTimeAsync(10);
    sink([{
      type: "node_session_sessions_update",
      nodeId: "node-a",
      data: { running_session_ids: ["session-live"] },
    }]);
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();
    expect(repository.reconcileNodeStartup).toHaveBeenCalledTimes(2);
  });
});

function disconnectEvent(connectionId: string) {
  return {
    type: "node_unregistered" as const,
    nodeId: "node-a",
    connectionId,
    reason: "socket_closed",
  };
}
