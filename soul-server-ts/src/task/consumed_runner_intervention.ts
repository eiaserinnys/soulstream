import type { InterventionMessage, Task } from "./task_models.js";

export async function discardConsumedRunnerIntervention(
  task: Task,
  deliveryId: string,
): Promise<void> {
  const queuedIndex = task.interventionQueue.findIndex(
    (message) => message.deliveryId === deliveryId,
  );
  if (queuedIndex < 0) return;
  const queued = task.interventionQueue[queuedIndex];
  if (!queued) {
    throw new Error(`Consumed delivery ${deliveryId} queue identity disappeared`);
  }
  task.interventionQueue.splice(queuedIndex, 1);
  if (task.runner?.eventPersistence !== "runner") return;
  const discard = task.runner.dispatcher.discardIntervention;
  if (!discard) {
    throw new Error("runner intervention discard operation is unavailable");
  }
  if (!queued.runnerInterventionId) {
    throw new Error(`Consumed delivery ${deliveryId} has no runner intervention identity`);
  }
  await discard.call(
    task.runner.dispatcher,
    queued.runnerInterventionId,
  );
}

export function matchesConsumedDelivery(
  row: {
    delivery_id: string;
    relation_key: string;
    completion_id: string | null;
    aggregate_state: string;
  } | null,
  message: Pick<
    InterventionMessage,
    "deliveryId" | "relationKey" | "completionId"
  >,
): boolean {
  if (!row || row.aggregate_state !== "consumed") return false;
  if (
    row.delivery_id !== message.deliveryId
    || row.relation_key !== message.relationKey
    || row.completion_id !== message.completionId
  ) {
    throw new Error(`Consumed delivery identity mismatch: ${message.deliveryId}`);
  }
  return true;
}
