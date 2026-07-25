import type { InterventionMessage, Task } from "./task_models.js";
import { buildDeterministicDeliveryIdentity } from "./delivery_identity.js";

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
