import type { NodeRegistryEvent } from "./registry.js";
import type { SessionMutationRepository } from
  "../control_plane/repositories/session_mutation_repository.js";

export type SessionReconciliationSink = (events: NodeRegistryEvent[]) => void;

export function createSessionReconciliationSink(input: {
  repositoryProvider(): Promise<Pick<
    SessionMutationRepository,
    "reconcileNodeDisconnected" | "reconcileNodeStartup"
  >>;
  logError(error: unknown, message: string): void;
  now?: () => Date;
}): SessionReconciliationSink {
  const tails = new Map<string, Promise<void>>();
  const now = input.now ?? (() => new Date());

  return (events) => {
    for (const event of events) {
      const operation = operationFromEvent(event, now);
      if (!operation) continue;
      const previous = tails.get(event.nodeId) ?? Promise.resolve();
      const current = previous.then(async () => {
        const repository = await input.repositoryProvider();
        await operation(repository);
      });
      const guarded = current.catch((error) => {
        input.logError(error, `session reconciliation failed for ${event.nodeId}`);
      });
      tails.set(event.nodeId, guarded);
      void guarded.finally(() => {
        if (tails.get(event.nodeId) === guarded) tails.delete(event.nodeId);
      });
    }
  };
}

function operationFromEvent(
  event: NodeRegistryEvent,
  now: () => Date,
): ((repository: Pick<
  SessionMutationRepository,
  "reconcileNodeDisconnected" | "reconcileNodeStartup"
>) => Promise<unknown>) | null {
  if (event.type === "node_unregistered") {
    return async (repository) => await repository.reconcileNodeDisconnected(event.nodeId, now());
  }
  if (event.type !== "node_session_sessions_update") return null;
  const runningSessionIds = event.data.running_session_ids;
  if (!Array.isArray(runningSessionIds) || !runningSessionIds.every((value) => typeof value === "string")) {
    return null;
  }
  return async (repository) => await repository.reconcileNodeStartup(
    event.nodeId,
    runningSessionIds,
    now(),
  );
}
