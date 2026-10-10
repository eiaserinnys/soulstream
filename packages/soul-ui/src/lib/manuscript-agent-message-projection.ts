import type { ChatMessage } from "./flatten-tree";

function isAgentReport(message: ChatMessage): boolean {
  if (message.role !== "user" && message.role !== "intervention") return false;

  if (message.callerInfo) return message.callerInfo.source === "agent";
  return message.role === "user" && message.agentInfo?.source === "agent";
}

function isAutomaticDeliveryNotice(message: ChatMessage): boolean {
  return message.role === "notification"
    && (message.deliveryIntent === "completion_notification"
      || message.deliveryIntent === "runtime_followup");
}

/** Removes internal delivery notices and agent reports from PAS manuscript rows. */
export function projectManuscriptMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => !isAutomaticDeliveryNotice(message) && !isAgentReport(message));
}
