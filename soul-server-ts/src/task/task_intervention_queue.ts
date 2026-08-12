import type { InterventionMessage, Task } from "./task_models.js";

export function enqueueInterventionOnce(
  task: Task,
  message: InterventionMessage,
): number {
  if (message.runnerInterventionId) {
    const existing = task.interventionQueue.findIndex(
      (queued) => queued.runnerInterventionId === message.runnerInterventionId,
    );
    if (existing >= 0) return existing + 1;
  }
  if (message.deliveryId) {
    const existing = task.interventionQueue.findIndex(
      (queued) => queued.deliveryId === message.deliveryId,
    );
    if (existing >= 0) return existing + 1;
  }
  task.interventionQueue.push(message);
  return task.interventionQueue.length;
}
