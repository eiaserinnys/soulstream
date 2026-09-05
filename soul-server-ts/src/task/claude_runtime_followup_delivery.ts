import type { InterventionMessage } from "./task_models.js";
interface RuntimeFollowupTerminal {
  deliveryId: string;
  relationKey: string;
  completionId: string;
  taskId: string;
  terminalRevision: string;
}

export function buildClaudeRuntimeFollowupDelivery(
  items: ReadonlyArray<RuntimeFollowupTerminal>,
): Partial<InterventionMessage> {
  if (items.length !== 1) {
    throw new Error("A runtime follow-up delivery must own exactly one generation");
  }
  const item = items[0]!;
  return {
    deliveryId: item.deliveryId,
    relationKey: item.relationKey,
    completionId: item.completionId,
    deliveryIntent: "runtime_followup",
    producerTerminalRevision: item.terminalRevision,
    deliveryCreatedAt: new Date().toISOString(),
  };
}
