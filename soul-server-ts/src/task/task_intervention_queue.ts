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

/**
 * A runtime follow-up owns a deterministic input UUID, so it can never share a
 * model input with another delivery. Ordinary high-priority inputs may still
 * be batched exactly as before.
 */
export function dequeueNextTurnInterventions(task: Task): InterventionMessage[] {
  const sorted = sortInterventionsByPriority(task.interventionQueue);
  const high = sorted.filter((message) => interventionPriorityLane(message) === "high");
  if (high.length > 0) {
    const ordinary = sorted.filter((message) => !isRuntimeFollowup(message));
    task.interventionQueue = sorted.filter(isRuntimeFollowup);
    return ordinary;
  }
  const first = sorted[0];
  if (!first) {
    task.interventionQueue = [];
    return [];
  }
  if (isRuntimeFollowup(first)) {
    task.interventionQueue = sorted.slice(1);
    return [first];
  }
  const ordinaryLow = sorted.filter((message) => !isRuntimeFollowup(message));
  task.interventionQueue = sorted.filter((message) => isRuntimeFollowup(message));
  return ordinaryLow;
}

export function dequeueInterventionsInLane(
  task: Task,
  lane: InterventionPriorityLane,
): InterventionMessage[] {
  const drained: InterventionMessage[] = [];
  const retained: InterventionMessage[] = [];
  for (const message of sortInterventionsByPriority(task.interventionQueue)) {
    (interventionPriorityLane(message) === lane ? drained : retained).push(message);
  }
  task.interventionQueue = retained;
  return drained;
}

function laneRank(lane: InterventionPriorityLane): number {
  return lane === "high" ? 0 : 1;
}

function isRuntimeFollowup(message: InterventionMessage): boolean {
  return message.deliveryIntent === "runtime_followup" ||
    message.source === LEGACY_RUNTIME_FOLLOWUP_SOURCE;
}
