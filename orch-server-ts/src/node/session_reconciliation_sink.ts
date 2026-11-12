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

const INVENTORY_RETRY_BASE_MS = 1_000;
const INVENTORY_RETRY_MAX_MS = 30_000;

type PendingReconciliation = {
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
  const inventoryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    const pending = pendingReconciliations.get(nodeId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingReconciliations.delete(nodeId);
  };

  const clearInventoryRetry = (nodeId: string): void => {
    const timer = inventoryRetryTimers.get(nodeId);
    if (timer === undefined) return;
    clearTimeout(timer);
    inventoryRetryTimers.delete(nodeId);
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

  const requestInventory = (
    nodeId: string,
    connectionId: string,
    attempt = 1,
  ): void => {
    if (!input.requestSessionInventory) return;
    clearInventoryRetry(nodeId);
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
        cancelPendingDisconnect(nodeId);
        publishUpdates(nodeId, result.updates);
      });
    })().catch((error) => {
      if (inventoryRequests.get(nodeId) !== token) return;
      inventoryRequests.delete(nodeId);
      input.logError(error, `runner inventory re-report failed for ${nodeId}`);
      if (closed) return;
      if (input.getConnectedNode?.(nodeId)?.connectionId !== connectionId) return;
      const delayMs = Math.min(
        INVENTORY_RETRY_BASE_MS * 2 ** (attempt - 1),
        INVENTORY_RETRY_MAX_MS,
      );
      clearInventoryRetry(nodeId);
      const timer = setTimeout(() => {
        inventoryRetryTimers.delete(nodeId);
        if (closed) return;
        if (input.getConnectedNode?.(nodeId)?.connectionId !== connectionId) return;
        requestInventory(nodeId, connectionId, attempt + 1);
      }, delayMs);
      timer.unref?.();
      inventoryRetryTimers.set(nodeId, timer);
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
          // A connected node is not absence evidence. Keep the kill off until a
          // server-requested inventory is matched; ask again instead.
          pendingReconciliations.delete(nodeId);
          input.logError(
            new Error(
              `connected node ${nodeId}/${connected.connectionId} missed its complete runner inventory`,
            ),
            `runner inventory re-report required for ${nodeId}`,
          );
          requestInventory(nodeId, connected.connectionId);
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
    scheduleReconciliationDeadline(nodeId, connectionId, disconnectGraceMs);
  };

  const deferDisconnect = (nodeId: string, connectionId: string): void => {
    scheduleReconciliationDeadline(nodeId, connectionId, disconnectGraceMs);
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
        clearInventoryRetry(event.nodeId);
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
    for (const timer of inventoryRetryTimers.values()) {
      clearTimeout(timer);
    }
    inventoryRetryTimers.clear();
    await startPromise?.catch(() => undefined);
    await Promise.all(tails.values());
  };

  return sink;
}
