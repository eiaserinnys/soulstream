import type { NodeRegistryEvent } from "./registry.js";
import type { SessionMutationRepository } from
  "../control_plane/repositories/session_mutation_repository.js";

type ReconciliationRepository = Pick<
  SessionMutationRepository,
  "reconcileNodeDisconnected" | "reconcileNodeStartup"
> & Partial<Pick<SessionMutationRepository, "listRunningNodeIds">>;

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
  leaseAware?: boolean;
  disconnectGraceMs?: number;
}): SessionReconciliationSink {
  const tails = new Map<string, Promise<void>>();
  const pendingDisconnects = new Map<string, PendingDisconnect>();
  const reportedNodes = new Set<string>();
  const now = input.now ?? (() => new Date());
  const leaseAware = input.leaseAware ?? false;
  const disconnectGraceMs = input.disconnectGraceMs ?? 0;
  let closed = false;
  let startPromise: Promise<void> | undefined;
  if (leaseAware && (!Number.isSafeInteger(disconnectGraceMs) || disconnectGraceMs <= 0)) {
    throw new Error("disconnectGraceMs must be a positive integer when lease-aware reconciliation is enabled");
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

  const deferDisconnect = (nodeId: string, connectionId: string): void => {
    if (closed) return;
    cancelPendingDisconnect(nodeId);
    const token = Symbol(connectionId);
    const timer = setTimeout(() => {
      enqueue(nodeId, async (repository) => {
        const pending = pendingDisconnects.get(nodeId);
        if (!pending || pending.token !== token) return;
        pendingDisconnects.delete(nodeId);
        await repository.reconcileNodeDisconnected(
          nodeId,
          now(),
          "node_disconnect_timeout",
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
      if (event.type === "node_unregistered") {
        reportedNodes.delete(event.nodeId);
        if (leaseAware) {
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
      if (leaseAware) {
        reportedNodes.add(event.nodeId);
        cancelPendingDisconnect(event.nodeId);
      }
      enqueue(event.nodeId, async (repository) => await repository.reconcileNodeStartup(
        event.nodeId,
        runningSessionIds,
        now(),
      ));
    }
  }) as SessionReconciliationSink;

  sink.start = async () => {
    if (!leaseAware) return;
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
