import type { ChatMessage } from "./flatten-tree";

/** Adds an assistant row for output IDs present only on the durable complete event. */
export function projectChatOutputAttachments(messages: ChatMessage[]): ChatMessage[] {
  const displayedInTurn = new Set<string>();
  const truncationAttachmentsInTurn = new Set<string>();
  const projected: ChatMessage[] = [];

  for (const message of messages) {
    if (message.treeNodeType === "generation_started") {
      displayedInTurn.clear();
      truncationAttachmentsInTurn.clear();
    }

    if (message.treeNodeType === "complete") {
      const attachmentIds = [...new Set(message.attachmentIds ?? [])];
      if (attachmentIds.length > 0 && message.eventId !== undefined) {
        projected.push({
          id: `output-attachments:${message.eventId}`,
          role: "assistant",
          content: "",
          timestamp: message.timestamp,
          attachmentIds,
          attachmentDisplayIds: attachmentIds.filter((id) => (
            !displayedInTurn.has(id) && !truncationAttachmentsInTurn.has(id)
          )),
          eventId: message.eventId,
          treeNodeId: `output-attachments:${message.eventId}`,
          treeNodeType: "assistant_message",
        });
      }
      projected.push(message);
      displayedInTurn.clear();
      truncationAttachmentsInTurn.clear();
      continue;
    }

    if (message.role === "assistant" && message.treeNodeType === "assistant_message") {
      const truncationAttachmentId = message.truncation?.attachment?.attachment_id;
      for (const id of message.attachmentIds ?? []) {
        if (id !== truncationAttachmentId) displayedInTurn.add(id);
      }
      if (truncationAttachmentId) truncationAttachmentsInTurn.add(truncationAttachmentId);
    }
    projected.push(message);
  }

  return projected;
}
