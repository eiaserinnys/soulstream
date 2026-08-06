import type { ChatMessage } from "../../lib/flatten-tree";
import type { MessageOrGroup } from "../../lib/grouping";

export type ChatThinkingIndicatorItem = {
  type: "thinking-indicator";
};

export type ChatTimelineItem = MessageOrGroup | ChatThinkingIndicatorItem;

const THINKING_INDICATOR_ITEM: ChatThinkingIndicatorItem = Object.freeze({
  type: "thinking-indicator",
});

function isEmptyStreamingAssistantText(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    message.treeNodeType === "text" &&
    message.isStreaming === true &&
    message.content.trim().length === 0
  );
}

export function shouldShowChatThinkingIndicator(
  sessionStatus: string | undefined,
  messages: ChatMessage[],
): boolean {
  if (sessionStatus !== "running") return false;
  return !messages.some(
    (message) =>
      message.role === "assistant" &&
      message.treeNodeType === "text" &&
      message.isStreaming === true &&
      message.content.trim().length > 0,
  );
}

export function buildChatTimelineItems(
  grouped: MessageOrGroup[],
  messages: ChatMessage[],
  sessionStatus: string | undefined,
): ChatTimelineItem[] {
  if (!shouldShowChatThinkingIndicator(sessionStatus, messages)) return grouped;
  const visibleItems = grouped.filter(
    (item) =>
      item.type !== "single" || !isEmptyStreamingAssistantText(item.msg),
  );
  return [...visibleItems, THINKING_INDICATOR_ITEM];
}
