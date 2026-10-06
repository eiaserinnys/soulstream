import type { ChatMessage } from "./flatten-tree";

function isAgentMessage(message: ChatMessage): boolean {
  return (message.role === "user" || message.role === "intervention")
    && message.callerInfo?.source === "agent";
}

/** Groups visible consecutive agent-originated user rows for the manuscript only. */
export function projectManuscriptAgentMessages(messages: ChatMessage[]): ChatMessage[] {
  const projected: ChatMessage[] = [];
  let pending: ChatMessage[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const first = pending[0]!;
    projected.push({
      id: `manuscript-agent-group-${first.id}`,
      role: "system",
      content: "",
      treeNodeId: first.treeNodeId,
      treeNodeType: "manuscript_agent_message_group",
      eventId: first.eventId,
      manuscriptAgentMessages: pending,
    });
    pending = [];
  };

  for (const message of messages) {
    if (isAgentMessage(message)) {
      pending.push(message);
    } else {
      flush();
      projected.push(message);
    }
  }
  flush();
  return projected;
}
