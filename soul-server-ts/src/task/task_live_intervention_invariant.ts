import type { SSEEventPayload } from "../engine/protocol.js";

import type { InterventionMessage, Task } from "./task_models.js";

/**
 * Invariant: a publicly delivered live intervention must either be consumed by a
 * meaningful engine event in the same turn, or restored to the fallback queue.
 */
export function markLiveInterventionInFlight(
  task: Task,
  message: InterventionMessage,
): void {
  task.liveInterventionsInFlight = [
    ...(task.liveInterventionsInFlight ?? []),
    message,
  ];
}

export function noteLiveInterventionEngineEvent(
  task: Task,
  event: SSEEventPayload,
): void {
  if (!task.liveInterventionsInFlight?.length) return;
  if (!eventConsumesLiveIntervention(event)) return;
  task.liveInterventionsInFlight = [];
}

export function restoreUnconsumedLiveInterventions(task: Task): number {
  const pending = task.liveInterventionsInFlight;
  if (!pending?.length) return 0;
  task.interventionQueue = [...pending, ...task.interventionQueue];
  task.liveInterventionsInFlight = [];
  return pending.length;
}

function eventConsumesLiveIntervention(event: SSEEventPayload): boolean {
  const record = event as Record<string, unknown>;
  switch (record.type) {
    case "assistant_message":
      return nonEmptyString(record.content);
    case "tool_start":
      return true;
    case "result":
      return nonEmptyString(record.output);
    case "complete":
      return nonEmptyString(record.result);
    default:
      return false;
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
