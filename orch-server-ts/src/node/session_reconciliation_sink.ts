import type { NodeStartupTarget } from "../control_plane/repositories/node_startup_reconciliation.js";
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
    targets?: NodeStartupTarget[],
  ): Promise<{ interrupted: number; restored: number; updates?: ReconciledSessionUpdate[] }>;
} & Partial<Pick<SessionMutationRepository, "listRunningNodeIds" | "captureNodeStartupTargets">>;

type ReconciliationOperation = (
  repository: ReconciliationRepository,
) => Promise<unknown>;

export const SESSION_INVENTORY_MAX_REQUESTS = 3;

type PendingReconciliation = {
  connectionId: string;
  token: symbol;
  timer: ReturnType<typeof setTimeout>;
  inventoryRequests: number;
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
  requestSessionInventory?(nodeId: string, connectionId: string): Promise<{
    requestId: string; runningSessionIds: string[];
  }>;
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
  const pendingReconciliations = new Map<string, PendingReconciliation>();
  const reportedNodes = new Set<string>();
  const inventoryRequests = new Map<string, symbol>();
  const now = input.now ?? (() => new Date());
  const restoreLeaseGraceOnStartup = input.restoreLeaseGraceOnStartup ?? false;
  const disconnectGraceMs = input.disconnectGraceMs ?? 0;
  const inventoryRetryMs = Math.max(
    1,
    Math.floor(disconnectGraceMs / SESSION_INVENTORY_MAX_REQUESTS),
  );
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
    const pending = pendingReconciliations.get(nodeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingReconciliations.delete(nodeId);
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

  const requestInventory = (nodeId: string, connectionId: string): void => {
    if (!input.requestSessionInventory) return;
    const token = Symbol(connectionId);
    inventoryRequests.set(nodeId, token);
    const isCurrent = () => !closed && inventoryRequests.get(nodeId) === token
      && input.getConnectedNode?.(nodeId)?.connectionId === connectionId;
    void (async () => {
      const repository = await input.repositoryProvider();
      if (!repository.captureNodeStartupTargets) {
        throw new Error("server startup target snapshot is required before inventory request");
      }
      const targets = await repository.captureNodeStartupTargets(nodeId);
      if (!isCurrent()) return;
      // This Promise belongs to a pending command scoped to this connection.
      const response = await input.requestSessionInventory!(nodeId, connectionId);
      if (!isCurrent()) return;
      enqueue(nodeId, async (currentRepository) => {
        if (!isCurrent()) return;
        inventoryRequests.delete(nodeId); // one accepted response, never replay the snapshot
        const result = await currentRepository.reconcileNodeStartup(
          nodeId, response.runningSessionIds, now(), targets,
        );
        publishUpdates(nodeId, result.updates);
      });
    })().catch((error) => {
      if (inventoryRequests.get(nodeId) === token) inventoryRequests.delete(nodeId);
      input.logError(error, `runner inventory re-report failed for ${nodeId}`);
    });
  };

  const reconcileTimedOutNode = async (
    repository: ReconciliationRepository,
    nodeId: string,
  ): Promise<void> => {
    const result = await repository.reconcileNodeDisconnected(
      nodeId,
      now(),
      "node_disconnect_timeout",
    );
    publishUpdates(
      nodeId,
      typeof result === "number" ? undefined : result.updates,
    );
  };

  const scheduleReconciliationDeadline = (
    nodeId: string,
    connectionId: string,
    delayMs: number,
    inventoryRequests: number,
  ): void => {
    if (closed) return;
    cancelPendingDisconnect(nodeId);
    const token = Symbol(connectionId);
    const timer = setTimeout(() => {
      enqueue(nodeId, async (repository) => {
        const pending = pendingReconciliations.get(nodeId);
        if (!pending || pending.token !== token) return;
        const connected = input.getConnectedNode?.(nodeId);
        if (connected) {
          if (connected.connectionId !== pending.connectionId) {
            input.logError(
              new Error(
                `connected node ${nodeId}/${connected.connectionId} missed its complete runner inventory`,
              ),
              `runner inventory re-report required for ${nodeId}`,
            );
            requestInventory(nodeId, connected.connectionId);
            scheduleReconciliationDeadline(
              nodeId,
              connected.connectionId,
              disconnectGraceMs,
              1,
            );
            return;
          }
          if (pending.inventoryRequests >= SESSION_INVENTORY_MAX_REQUESTS) {
            pendingReconciliations.delete(nodeId);
            input.logError(
              new Error(
                `connected node ${nodeId}/${connected.connectionId} inventory watchdog `
                + `exhausted after ${pending.inventoryRequests} requests`,
              ),
              `runner inventory watchdog exhausted for ${nodeId}`,
            );
            // A connected node with no correlated response is not absence evidence.
            return;
          }
          input.logError(
            new Error(
              `connected node ${nodeId}/${connected.connectionId} missed its complete runner inventory`,
            ),
            `runner inventory re-report required for ${nodeId}`,
          );
          requestInventory(nodeId, connected.connectionId);
          scheduleReconciliationDeadline(
            nodeId,
            connected.connectionId,
            inventoryRetryMs,
            pending.inventoryRequests + 1,
          );
          return;
        }
        pendingReconciliations.delete(nodeId);
        await reconcileTimedOutNode(repository, nodeId);
      });
    }, delayMs);
    timer.unref?.();
    pendingReconciliations.set(nodeId, {
      connectionId,
      token,
      timer,
      inventoryRequests,
    });
  };

  const armConnectionInventoryWatchdog = (
    nodeId: string,
    connectionId: string,
  ): void => {
    const pending = pendingReconciliations.get(nodeId);
    if (pending?.connectionId === connectionId) {
      return;
    }
    scheduleReconciliationDeadline(
      nodeId,
      connectionId,
      disconnectGraceMs,
      input.requestSessionInventory ? 1 : 0,
    );
  };

  const deferDisconnect = (nodeId: string, connectionId: string): void => {
    scheduleReconciliationDeadline(nodeId, connectionId, disconnectGraceMs, 0);
  };

  const sink = ((events: NodeRegistryEvent[]) => {
    if (closed) return;
    for (const event of events) {
      if (event.type === "node_registered" || event.type === "node_updated") {
        if (event.type === "node_registered") {
          inventoryRequests.delete(event.nodeId);
          requestInventory(event.nodeId, event.connectionId);
        }
        if (input.isLeaseAwareNode?.(event.nodeId) === true) {
          if (event.type === "node_registered") reportedNodes.delete(event.nodeId);
          if (!reportedNodes.has(event.nodeId)) {
            armConnectionInventoryWatchdog(event.nodeId, event.connectionId);
          }
        } else {
          cancelPendingDisconnect(event.nodeId);
        }
        continue;
      }
      if (event.type === "node_unregistered") {
        inventoryRequests.delete(event.nodeId);
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
      if (
        event.type !== "node_session_sessions_update"
        && event.type !== "node_runner_inventory"
      ) continue;
      const runningSessionIds = event.data.running_session_ids;
      if (
        !Array.isArray(runningSessionIds)
        || !runningSessionIds.every((value) => typeof value === "string")
      ) {
        continue;
      }
      reportedNodes.add(event.nodeId);
      cancelPendingDisconnect(event.nodeId);
      const snapshotAt = now();
      enqueue(event.nodeId, async (repository) => {
        const result = await repository.reconcileNodeStartup(
          event.nodeId,
          runningSessionIds,
          snapshotAt,
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
    for (const pending of pendingReconciliations.values()) {
      clearTimeout(pending.timer);
    }
    pendingReconciliations.clear();
    inventoryRequests.clear();
    await startPromise?.catch(() => undefined);
    await Promise.all(tails.values());
  };

  return sink;
}
