import type { NodeRegistryEvent, NodeUnregisteredEvent } from "./registry.js";
import type { SessionMutationRepository } from
  "../control_plane/repositories/session_mutation_repository.js";

type ReconciliationRepository = Pick<
  SessionMutationRepository,
  "reconcileNodeDisconnected" | "reconcileNodeStartup"
>;

type ReconciliationOperation = (
  repository: ReconciliationRepository,
) => Promise<unknown>;

type PendingDisconnect = {
  connectionId: string;
  token: symbol;
  timer: ReturnType<typeof setTimeout>;
};

export type SessionReconciliationSink = (events: NodeRegistryEvent[]) => void;

export function createSessionReconciliationSink(input: {
  repositoryProvider(): Promise<ReconciliationRepository>;
  logError(error: unknown, message: string): void;
  now?: () => Date;
  leaseAware?: boolean;
  disconnectGraceMs?: number;
}): SessionReconciliationSink {
  const tails = new Map<string, Promise<void>>();
  const pendingDisconnects = new Map<string, PendingDisconnect>();
  const now = input.now ?? (() => new Date());
  const leaseAware = input.leaseAware ?? false;
  const disconnectGraceMs = input.disconnectGraceMs ?? 0;
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

  const deferDisconnect = (event: NodeUnregisteredEvent): void => {
    cancelPendingDisconnect(event.nodeId);
    const token = Symbol(event.connectionId);
    const timer = setTimeout(() => {
      enqueue(event.nodeId, async (repository) => {
        const pending = pendingDisconnects.get(event.nodeId);
        if (!pending || pending.token !== token) return;
        pendingDisconnects.delete(event.nodeId);
        await repository.reconcileNodeDisconnected(
          event.nodeId,
          now(),
          "node_disconnect_timeout",
        );
      });
    }, disconnectGraceMs);
    timer.unref?.();
    pendingDisconnects.set(event.nodeId, {
      connectionId: event.connectionId,
      token,
      timer,
    });
  };

  return (events) => {
    for (const event of events) {
      if (event.type === "node_unregistered") {
        if (leaseAware) {
          deferDisconnect(event);
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
      if (leaseAware) cancelPendingDisconnect(event.nodeId);
      enqueue(event.nodeId, async (repository) => await repository.reconcileNodeStartup(
        event.nodeId,
        runningSessionIds,
        now(),
      ));
    }
  };
}
