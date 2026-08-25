import type { InterventionMessage, Task } from "./task_models.js";

const LOW_PRIORITY_DELIVERY_INTENTS = new Set([
  "completion_notification",
  "runtime_followup",
]);
const LEGACY_RUNTIME_FOLLOWUP_SOURCE = "claude_runtime_task_followup";

export type InterventionPriorityLane = "high" | "low";

export function interventionPriorityLane(
  message: Pick<InterventionMessage, "deliveryIntent" | "source">,
): InterventionPriorityLane {
  if (
    (message.deliveryIntent && LOW_PRIORITY_DELIVERY_INTENTS.has(message.deliveryIntent))
    || message.source === LEGACY_RUNTIME_FOLLOWUP_SOURCE
  ) {
    return "low";
  }
  return "high";
}

export function sortInterventionsByPriority<T extends Pick<
  InterventionMessage,
  "deliveryIntent" | "source"
>>(messages: readonly T[]): T[] {
  return [...messages].sort(compareInterventionPriority);
}

export function compareInterventionPriority(
  left: Pick<InterventionMessage, "deliveryIntent" | "source">,
  right: Pick<InterventionMessage, "deliveryIntent" | "source">,
): number {
  return laneRank(interventionPriorityLane(left)) - laneRank(interventionPriorityLane(right));
}

export function enqueueInterventionOnce(
  task: Task,
  message: InterventionMessage,
): number {
  if (task.interventionQueue.length > 1) {
    task.interventionQueue = sortInterventionsByPriority(task.interventionQueue);
  }
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
  task.interventionQueue = sortInterventionsByPriority(task.interventionQueue);
  return task.interventionQueue.indexOf(message) + 1;
}

export function dequeueInterventions(task: Task): InterventionMessage[] {
  const drained = sortInterventionsByPriority(task.interventionQueue);
  task.interventionQueue = [];
  return drained;
}

function laneRank(lane: InterventionPriorityLane): number {
  return lane === "high" ? 0 : 1;
}
