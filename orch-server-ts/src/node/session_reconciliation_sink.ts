import type { NodeRegistryEvent } from "./registry.js";
import type { SessionMutationRepository } from
  "../control_plane/repositories/session_mutation_repository.js";

type ReconciledSessionUpdate = {
  sessionId: string;
  status: "interrupted" | "running";
  terminationReason: string | null;
  terminationDetail: string | null;
  reviewState: string;
  updatedAt: Date;
};

type ReconciliationRepository = {
  reconcileNodeDisconnected(
    nodeId: string,
    updatedAt: Date,
    terminationDetail: "node_disconnect" | "node_disconnect_timeout",
  ): Promise<
    number | { interrupted: number; updates?: ReconciledSessionUpdate[] }
  >;
  reconcileNodeStartup(
    nodeId: string,
    runningSessionIds: string[],
    updatedAt: Date,
  ): Promise<{ interrupted: number; restored: number; updates?: ReconciledSessionUpdate[] }>;
} & Partial<Pick<SessionMutationRepository, "listRunningNodeIds">>;

type ReconciliationOperation = (
  repository: ReconciliationRepository,
) => Promise<unknown>;

type PendingDisconnect = {
  connectionId: string;
  token: symbol;
  timer: ReturnType<typeof setTimeout>;
};

export type SessionReconciliationSink = {
  (events: NodeRegistryEvent[]): void;
  start(): Promise<void>;
  close(): Promise<void>;
};

export function createSessionReconciliationSink(input: {
  repositoryProvider(): Promise<ReconciliationRepository>;
  logError(error: unknown, message: string): void;
  now?: () => Date;
  isLeaseAwareNode?(nodeId: string): boolean;
  restoreLeaseGraceOnStartup?: boolean;
  disconnectGraceMs?: number;
  getConnectedNode?(nodeId: string): { connectionId: string } | undefined;
  requestSessionInventory?(nodeId: string): Promise<void>;
  publishSessionUpdate?(input: {
    nodeId: string;
    agentSessionId: string;
    status: "interrupted" | "running";
    terminationReason: string | null;
    terminationDetail: string | null;
    reviewState: string;
    updatedAt: Date;
  }): void;
}): SessionReconciliationSink {
  const tails = new Map<string, Promise<void>>();
  const pendingDisconnects = new Map<string, PendingDisconnect>();
  const reportedNodes = new Set<string>();
  const now = input.now ?? (() => new Date());
  const restoreLeaseGraceOnStartup = input.restoreLeaseGraceOnStartup ?? false;
  const disconnectGraceMs = input.disconnectGraceMs ?? 0;
  let closed = false;
  let startPromise: Promise<void> | undefined;
  if (
    (input.isLeaseAwareNode || restoreLeaseGraceOnStartup)
    && (!Number.isSafeInteger(disconnectGraceMs) || disconnectGraceMs <= 0)
  ) {
    throw new Error(
      "disconnectGraceMs must be a positive integer when lease-aware reconciliation is enabled",
    );
  }

  const enqueue = (nodeId: string, operation: ReconciliationOperation): void => {
    const previous = tails.get(nodeId) ?? Promise.resolve();
    const current = previous.then(async () => {
      const repository = await input.repositoryProvider();
      await operation(repository);
    });
    const guarded = current.catch((error) => {
      input.logError(error, `session reconciliation failed for ${nodeId}`);
    });
    tails.set(nodeId, guarded);
    void guarded.finally(() => {
      if (tails.get(nodeId) === guarded) tails.delete(nodeId);
    });
  };

  const cancelPendingDisconnect = (nodeId: string): void => {
    const pending = pendingDisconnects.get(nodeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDisconnects.delete(nodeId);
  };

  const publishUpdates = (
    nodeId: string,
    updates: ReconciledSessionUpdate[] | undefined,
  ): void => {
    for (const update of updates ?? []) {
      input.publishSessionUpdate?.({
        nodeId,
        agentSessionId: update.sessionId,
        status: update.status,
        terminationReason: update.terminationReason,
        terminationDetail: update.terminationDetail,
        reviewState: update.reviewState,
        updatedAt: update.updatedAt,
      });
    }
  };

  const requestInventory = (nodeId: string): void => {
    if (!input.requestSessionInventory) return;
    void input.requestSessionInventory(nodeId).catch((error) => {
      input.logError(error, `runner inventory re-report failed for ${nodeId}`);
    });
  };

  const deferDisconnect = (nodeId: string, connectionId: string): void => {
    if (closed) return;
    cancelPendingDisconnect(nodeId);
    const token = Symbol(connectionId);
    const timer = setTimeout(() => {
      enqueue(nodeId, async (repository) => {
        const pending = pendingDisconnects.get(nodeId);
        if (!pending || pending.token !== token) return;
        const connected = input.getConnectedNode?.(nodeId);
        if (connected) {
          input.logError(
            new Error(
              `connected node ${nodeId}/${connected.connectionId} missed its complete runner inventory`,
            ),
            `runner inventory re-report required for ${nodeId}`,
          );
          deferDisconnect(nodeId, connected.connectionId);
          requestInventory(nodeId);
          return;
        }
        pendingDisconnects.delete(nodeId);
        const result = await repository.reconcileNodeDisconnected(
          nodeId,
          now(),
          "node_disconnect_timeout",
        );
        publishUpdates(
          nodeId,
          typeof result === "number" ? undefined : result.updates,
        );
      });
    }, disconnectGraceMs);
    timer.unref?.();
    pendingDisconnects.set(nodeId, {
      connectionId,
      token,
      timer,
    });
  };

  const sink = ((events: NodeRegistryEvent[]) => {
    if (closed) return;
    for (const event of events) {
      if (event.type === "node_registered" || event.type === "node_updated") {
        cancelPendingDisconnect(event.nodeId);
        continue;
      }
      if (event.type === "node_unregistered") {
        reportedNodes.delete(event.nodeId);
        if (input.isLeaseAwareNode?.(event.nodeId) === true) {
          deferDisconnect(event.nodeId, event.connectionId);
        } else {
          enqueue(event.nodeId, async (repository) =>
            await repository.reconcileNodeDisconnected(
              event.nodeId,
              now(),
              "node_disconnect",
            ));
        }
        continue;
      }
      if (event.type !== "node_session_sessions_update") continue;
      const runningSessionIds = event.data.running_session_ids;
      if (
        !Array.isArray(runningSessionIds)
        || !runningSessionIds.every((value) => typeof value === "string")
      ) {
        continue;
      }
      reportedNodes.add(event.nodeId);
      cancelPendingDisconnect(event.nodeId);
      enqueue(event.nodeId, async (repository) => {
        const result = await repository.reconcileNodeStartup(
          event.nodeId,
          runningSessionIds,
          now(),
        );
        publishUpdates(event.nodeId, result.updates);
      });
    }
  }) as SessionReconciliationSink;

  sink.start = async () => {
    if (!restoreLeaseGraceOnStartup) return;
    if (closed) throw new Error("session reconciliation sink is closed");
    startPromise ??= (async () => {
      const repository = await input.repositoryProvider();
      if (!repository.listRunningNodeIds) {
        throw new Error("listRunningNodeIds is required for lease-aware startup reconciliation");
      }
      const runningNodeIds = await repository.listRunningNodeIds();
      for (const nodeId of new Set(runningNodeIds)) {
        if (reportedNodes.has(nodeId)) continue;
        deferDisconnect(nodeId, `startup-sweep:${nodeId}`);
      }
    })();
    await startPromise;
  };

  sink.close = async () => {
    if (closed) return;
    closed = true;
    for (const pending of pendingDisconnects.values()) {
      clearTimeout(pending.timer);
    }
    pendingDisconnects.clear();
    await startPromise?.catch(() => undefined);
    await Promise.all(tails.values());
  };

  return sink;
}
