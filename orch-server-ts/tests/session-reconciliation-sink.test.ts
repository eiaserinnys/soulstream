import { describe, expect, it, vi } from "vitest";

import { createSessionReconciliationSink } from
  "../src/node/session_reconciliation_sink.js";

describe("createSessionReconciliationSink", () => {
  it("serializes disconnect before startup reconciliation for the same node", async () => {
    const order: string[] = [];
    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => {
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
});
