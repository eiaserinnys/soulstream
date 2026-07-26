import type { InterventionMessage, Task } from "./task_models.js";
import {
  buildDeterministicDeliveryIdentity,
  hashDeliveryPayload,
} from "./delivery_identity.js";

interface RuntimeFollowupTerminal {
  taskId: string;
  terminalRevision: string;
}

export function buildClaudeRuntimeFollowupDelivery(
  task: Task,
  items: ReadonlyArray<RuntimeFollowupTerminal>,
): Partial<InterventionMessage> {
  const terminalRevision = items
    .map((item) => `${item.taskId}@${item.terminalRevision}`)
    .sort()
    .join(",");
  const relationKey =
    `claude_runtime:${task.agentSessionId}:${task.claudeRuntime?.sessionId ?? "unknown"}:${terminalRevision}`;
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: task.agentSessionId,
    relationKey,
    intent: "runtime_followup",
  });
  return {
    ...identity,
    deliveryIntent: "runtime_followup",
    producerTerminalRevision: terminalRevision,
    deliveryCreatedAt: new Date().toISOString(),
  };
}

export function buildClaudeRuntimeFollowupFallbackDelivery(
  task: Task,
  parent: InterventionMessage,
  params: {
    text: string;
    reason: "empty_response" | "repeated_response";
    attempt: number;
    followupTaskIds?: ReadonlyArray<string>;
  },
): Partial<InterventionMessage> {
  if (!parent.deliveryId) {
    throw new Error("Runtime follow-up fallback requires a parent delivery id");
  }
  const contentFingerprint = hashDeliveryPayload({
    text: params.text,
    user: "system",
    source: "claude_runtime_task_followup",
    caller_info: parent.callerInfo ?? null,
    followup_task_ids: params.followupTaskIds ?? null,
    reason: params.reason,
    attempt: params.attempt,
  });
  const relationKey = [
    "claude_runtime_fallback",
    task.agentSessionId,
    parent.deliveryId,
    String(params.attempt),
    contentFingerprint,
  ].join(":");
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: task.agentSessionId,
    relationKey,
    intent: "runtime_followup",
  });
  return {
    ...identity,
    deliveryIntent: "runtime_followup",
    parentDeliveryId: parent.deliveryId,
    producerTerminalRevision: [
      parent.producerTerminalRevision ?? parent.deliveryId,
      `fallback-${params.attempt}`,
      params.reason,
      contentFingerprint,
    ].join(":"),
    deliveryCreatedAt: new Date().toISOString(),
  };
}
