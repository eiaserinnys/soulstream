import { randomUUID } from "node:crypto";

import type { InterventionMessage, Task } from "./task_models.js";
import { instructionNumberOf } from "./state/node_instruction_decision.js";

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

/**
 * 러너에 넘기려 한 적이 있는 지시. 넘김을 시도한 뒤 큐로 되돌아온 지시에 노드가 남기는 표시다.
 * 메모리에만 두고 wire에 싣지 않는다. 잊힌 task의 큐 정산이 이 표시로 「넘기려 한 적 없음」과
 * 「넘김 시도 뒤 되돌아옴」을 가른다(ledger의 dispatching_at은 서버가 노드에 넘기기 시작한 표시라
 * 메모리 큐 지시에는 거의 늘 값이 있어 기준이 되지 못한다).
 */
const handoffAttempted = new WeakSet<InterventionMessage>();

export function markHandoffAttempted(message: InterventionMessage): void {
  handoffAttempted.add(message);
}

export function wasHandoffAttempted(message: InterventionMessage): boolean {
  return handoffAttempted.has(message);
}

/**
 * 러너에 넘긴 뒤 큐로 되돌아오는 지시를 시도 표시와 함께 다시 큐에 넣는다. 같은 지시 번호나
 * deliveryId의 항목이 이미 큐에 있으면 그 항목과 합쳐지고 큐에 있던 항목이 남으므로, 남는 항목에도
 * 표시를 남긴다(그러지 않으면 시도한 지시가 「시도한 적 없음」으로 서버에 돌아가 두 번 들어갈 수 있다).
 */
export function requeueAfterHandoffAttempt(
  task: Task,
  message: InterventionMessage,
): number {
  markHandoffAttempted(message);
  const position = enqueueInterventionOnce(task, message);
  const kept = task.interventionQueue[position - 1];
  if (kept) markHandoffAttempted(kept);
  return position;
}

export function enqueueInterventionOnce(
  task: Task,
  message: InterventionMessage,
): number {
  // 큐에 들어오는 지시는 어느 길로 왔든 러너에 넘기기 전에 번호를 갖는다. 장부 번호도 넘기기 전
  // 번호도 없으면 그 자리에서 채운다. 같은 객체가 큐와 시동 장벽에 함께 걸려 있어 복사하지 않는다.
  if (instructionNumberOf(message) === undefined) {
    message.runnerInterventionId = randomUUID();
  }
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

/** Removes exactly the message that owned a failed admission, keeping other input. */
export function removeInterventionMessage(
  task: Task,
  message: InterventionMessage,
): boolean {
  const index = message.deliveryId
    ? task.interventionQueue.findIndex(
        (queued) => queued.deliveryId === message.deliveryId,
      )
    : task.interventionQueue.indexOf(message);
  if (index < 0) return false;
  task.interventionQueue.splice(index, 1);
  return true;
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

/**
 * Put an unstarted ordinary batch back at the front and select the next batch
 * with the standard rules so arrivals during compaction can join it. Runtime
 * follow-up batches have exact input UUIDs, so they remain unchanged.
 */
export function rejoinUnstartedInterventions(
  task: Task,
  unstarted: InterventionMessage[],
): InterventionMessage[] {
  if (task.interventionQueue.length === 0 || unstarted.some(isRuntimeFollowup)) return unstarted;
  task.interventionQueue = [...unstarted, ...task.interventionQueue];
  return dequeueNextTurnInterventions(task);
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

export function isRuntimeFollowup(message: InterventionMessage): boolean {
  return message.deliveryIntent === "runtime_followup" ||
    message.source === LEGACY_RUNTIME_FOLLOWUP_SOURCE;
}
