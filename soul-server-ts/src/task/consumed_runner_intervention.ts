import type { InterventionMessage, Task } from "./task_models.js";

export async function discardConsumedRunnerIntervention(
  task: Task,
  deliveryId: string,
): Promise<void> {
  const queued = task.interventionQueue.find(
    (message) => message.deliveryId === deliveryId,
  );
  task.interventionQueue = task.interventionQueue.filter(
    (message) => message.deliveryId !== deliveryId,
  );
  if (task.runner?.eventPersistence !== "runner") return;
  const discard = task.runner.dispatcher.discardIntervention;
  if (!discard) {
    throw new Error("runner intervention discard operation is unavailable");
  }
  await discard.call(
    task.runner.dispatcher,
    queued?.runnerInterventionId ?? deliveryId,
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
