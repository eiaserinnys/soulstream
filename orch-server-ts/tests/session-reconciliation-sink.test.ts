import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionReconciliationSink } from
  "../src/node/session_reconciliation_sink.js";
import {
  InMemoryNodeRegistry,
  type NodeRegistrationPayload,
} from "../src/node/registry.js";

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

  it("captures the inventory snapshot fence before queued work can observe newer sessions", async () => {
    let current = new Date("2026-08-06T00:00:00.000Z");
    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => {
        await disconnectGate;
        return 0;
      }),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      now: () => current,
    });

    sink([{ type: "node_unregistered", nodeId: "node-a" } as never]);
    const snapshotAt = current;
    sink([{
      type: "node_session_sessions_update",
      nodeId: "node-a",
      data: { running_session_ids: ["session-live"] },
    }]);
    current = new Date("2026-08-06T00:01:00.000Z");
    releaseDisconnect();

    await vi.waitFor(() => expect(repository.reconcileNodeStartup).toHaveBeenCalled());
    expect(repository.reconcileNodeStartup).toHaveBeenCalledWith(
      "node-a",
      ["session-live"],
      snapshotAt,
    );
  });

  it("accepts the lightweight runner inventory event without a durable session dump", async () => {
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 0),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 1 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
    });

    sink([{
      type: "node_runner_inventory",
      nodeId: "node-a",
      data: { type: "runner_inventory", running_session_ids: ["session-live"] },
    } as never]);

    await vi.waitFor(() => expect(repository.reconcileNodeStartup).toHaveBeenCalledWith(
      "node-a",
      ["session-live"],
      expect.any(Date),
    ));
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

  it("keeps startup reconciliation inert when lease awareness is disabled", async () => {
    const listRunningNodeIds = vi.fn(async () => ["node-a"]);
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => ({
        listRunningNodeIds,
        reconcileNodeDisconnected: vi.fn(),
        reconcileNodeStartup: vi.fn(),
      }),
      logError: vi.fn(),
      isLeaseAwareNode: () => false,
      disconnectGraceMs: 1,
    });

    await sink.start();

    expect(listRunningNodeIds).not.toHaveBeenCalled();
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
      isLeaseAwareNode: () => true,
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
      isLeaseAwareNode: () => true,
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

  it("preserves a live runner across disconnect, reconnect, and a complete inventory report", async () => {
    vi.useFakeTimers();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 1 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 10,
    });
    const registry = new InMemoryNodeRegistry();
    const registration = nodeRegistration();
    const first = registry.registerNode(registration);

    sink([registry.disconnectNode("node-a", {
      connectionId: first.node.connectionId,
      reason: "socket_closed",
    })]);
    const second = registry.registerNode(registration);
    sink(registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId: second.node.connectionId },
      {
        type: "sessions_update",
        sessions: [],
        running_session_ids: ["session-runner"],
      } as never,
    ));
    await vi.advanceTimersByTimeAsync(10);

    expect(repository.reconcileNodeStartup).toHaveBeenCalledWith(
      "node-a",
      ["session-runner"],
      expect.any(Date),
    );
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();
  });

  it("restores an adopted runner in DB, cache, and client exactly once before replay", async () => {
    const registry = new InMemoryNodeRegistry();
    const registered = registry.registerNode(nodeRegistration());
    const inventory = {
      type: "sessions_update",
      sessions: [{ agentSessionId: "session-runner", status: "interrupted" }],
      running_session_ids: ["session-runner"],
    };
    const firstInventoryEvents = registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId: registered.node.connectionId },
      inventory as never,
    );
    let durableStatus: "interrupted" | "running" = "interrupted";
    const clientStatuses: string[] = [];
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 0),
      reconcileNodeStartup: vi.fn(async () => {
        if (durableStatus === "running") {
          return { interrupted: 0, restored: 0, updates: [] };
        }
        durableStatus = "running";
        return {
          interrupted: 0,
          restored: 1,
          updates: [{
            sessionId: "session-runner",
            status: "running" as const,
            terminationReason: null,
            terminationDetail: null,
            reviewState: "not_required",
            updatedAt: new Date("2026-08-11T00:00:00.000Z"),
          }],
        };
      }),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 10,
      publishSessionUpdate: (update) => {
        const events = registry.receiveNodeMessage(
          { nodeId: update.nodeId, connectionId: registered.node.connectionId },
          {
            type: "session_updated",
            agentSessionId: update.agentSessionId,
            status: update.status,
            review_state: update.reviewState,
          },
        );
        if (events.some((event) => event.type === "node_session_session_updated")) {
          clientStatuses.push(update.status);
        }
      },
    });

    sink(firstInventoryEvents);
    await vi.waitFor(() => expect(durableStatus).toBe("running"));
    expect(registry.sessionCache.findSession("session-runner")?.status).toBe("running");
    expect(clientStatuses).toEqual(["running"]);

    // The next complete inventory reflects the durable transition even before
    // runner event replay, and the reconciliation itself remains a no-op.
    sink(registry.receiveNodeMessage(
      { nodeId: "node-a", connectionId: registered.node.connectionId },
      {
        ...inventory,
        sessions: [{ agentSessionId: "session-runner", status: "running" }],
      } as never,
    ));
    await vi.waitFor(() => expect(repository.reconcileNodeStartup).toHaveBeenCalledTimes(2));
    expect(durableStatus).toBe("running");
    expect(registry.sessionCache.findSession("session-runner")?.status).toBe("running");
    expect(clientStatuses).toEqual(["running"]);
  });

  it("restores disconnect grace after an orch restart and expires an absent node explicitly", async () => {
    vi.useFakeTimers();
    const repository = {
      listRunningNodeIds: vi.fn(async () => ["node-a"]),
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const beforeRestart = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 10,
    });
    beforeRestart([disconnectEvent("connection-before-restart")]);
    await beforeRestart.close();

    const afterRestart = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      isLeaseAwareNode: () => true,
      restoreLeaseGraceOnStartup: true,
      disconnectGraceMs: 10,
    });
    await afterRestart.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(repository.listRunningNodeIds).toHaveBeenCalledOnce();
    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledWith(
      "node-a",
      expect.any(Date),
      "node_disconnect_timeout",
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
      isLeaseAwareNode: () => true,
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
      isLeaseAwareNode: () => true,
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
      isLeaseAwareNode: () => true,
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

  it("gates disconnect grace per node capability in a mixed cluster", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryNodeRegistry();
    const runner = registry.registerNode(nodeRegistration("node-runner", true));
    const legacy = registry.registerNode(nodeRegistration("node-legacy", false));
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      isLeaseAwareNode: (nodeId) =>
        registry.getNodeState(nodeId)?.capabilities.runner_process_v1 === true,
      disconnectGraceMs: 10,
    });

    sink([registry.disconnectNode("node-runner", {
      connectionId: runner.node.connectionId,
      reason: "socket_closed",
    })]);
    sink([registry.disconnectNode("node-legacy", {
      connectionId: legacy.node.connectionId,
      reason: "socket_closed",
    })]);
    await vi.advanceTimersByTimeAsync(0);

    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledWith(
      "node-legacy",
      expect.any(Date),
      "node_disconnect",
    );
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalledWith(
      "node-runner",
      expect.any(Date),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledWith(
      "node-runner",
      expect.any(Date),
      "node_disconnect_timeout",
    );
  });

  it("requests a fresh inventory instead of killing when the node is connected at expiry", async () => {
    vi.useFakeTimers();
    const requestSessionInventory = vi.fn(async () => undefined);
    const logError = vi.fn();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError,
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 10,
      getConnectedNode: () => ({ connectionId: "connection-live" }),
      requestSessionInventory,
    });

    sink([disconnectEvent("connection-old")]);
    await vi.advanceTimersByTimeAsync(10);

    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();
    expect(requestSessionInventory).toHaveBeenCalledWith("node-a");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("missed") }),
      "runner inventory re-report required for node-a",
    );
  });

  it("starts a complete-inventory watchdog without extending it on registration refresh", async () => {
    vi.useFakeTimers();
    const requestSessionInventory = vi.fn(async () => undefined);
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 12,
      getConnectedNode: () => ({ connectionId: "connection-new" }),
      requestSessionInventory,
    });

    sink([disconnectEvent("connection-old")]);
    sink([{ type: "node_registered", nodeId: "node-a", connectionId: "connection-new" }]);
    expect(requestSessionInventory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6);
    sink([{
      type: "node_updated",
      nodeId: "node-a",
      connectionId: "connection-new",
      node: {} as never,
    }]);
    await vi.advanceTimersByTimeAsync(6);

    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();
    expect(requestSessionInventory).toHaveBeenCalledTimes(1);
  });

  it("terminally reconciles a connected node after the finite inventory retry budget", async () => {
    vi.useFakeTimers();
    const requestSessionInventory = vi.fn(async () => undefined);
    const logError = vi.fn();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => 1),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError,
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 12,
      getConnectedNode: () => ({ connectionId: "connection-new" }),
      requestSessionInventory,
    });

    sink([{ type: "node_registered", nodeId: "node-a", connectionId: "connection-new" }]);
    expect(requestSessionInventory).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12);
    expect(requestSessionInventory).toHaveBeenCalledTimes(1);
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4);
    expect(requestSessionInventory).toHaveBeenCalledTimes(2);
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4);
    expect(requestSessionInventory).toHaveBeenCalledTimes(3);
    expect(repository.reconcileNodeDisconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4);
    expect(repository.reconcileNodeDisconnected).toHaveBeenCalledWith(
      "node-a",
      expect.any(Date),
      "node_disconnect_timeout",
    );
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("exhausted after 3 requests"),
      }),
      "runner inventory watchdog exhausted for node-a",
    );
  });

  it("publishes every timeout interruption after the grace window expires", async () => {
    vi.useFakeTimers();
    const updatedAt = new Date("2026-08-12T00:00:00.000Z");
    const publishSessionUpdate = vi.fn();
    const repository = {
      reconcileNodeDisconnected: vi.fn(async () => ({
        interrupted: 1,
        updates: [{
          sessionId: "session-timeout",
          status: "interrupted" as const,
          terminationReason: "killed",
          terminationDetail: "node_disconnect_timeout",
          reviewState: "needs_review",
          updatedAt,
        }],
      })),
      reconcileNodeStartup: vi.fn(async () => ({ interrupted: 0, restored: 0 })),
    };
    const sink = createSessionReconciliationSink({
      repositoryProvider: async () => repository,
      logError: vi.fn(),
      now: () => updatedAt,
      isLeaseAwareNode: () => true,
      disconnectGraceMs: 10,
      publishSessionUpdate,
    });

    sink([disconnectEvent("connection-old")]);
    await vi.advanceTimersByTimeAsync(10);

    expect(publishSessionUpdate).toHaveBeenCalledWith({
      nodeId: "node-a",
      agentSessionId: "session-timeout",
      status: "interrupted",
      terminationReason: "killed",
      terminationDetail: "node_disconnect_timeout",
      reviewState: "needs_review",
      updatedAt,
    });
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

function nodeRegistration(
  nodeId = "node-a",
  runnerProcessEnabled?: boolean,
): NodeRegistrationPayload {
  return {
    type: "node_register",
    node_id: nodeId,
    host: "127.0.0.1",
    port: 4205,
    agents: [],
    capabilities: runnerProcessEnabled === undefined
      ? {}
      : { runner_process_v1: runnerProcessEnabled },
    supported_backends: ["claude"],
  };
}
