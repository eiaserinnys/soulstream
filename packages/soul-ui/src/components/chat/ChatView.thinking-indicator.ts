import type { ChatMessage } from "../../lib/flatten-tree";
import type { MessageOrGroup } from "../../lib/grouping";
import type { PendingChatSend } from "../../stores/dashboard-store-types";

export type ChatThinkingIndicatorItem = {
  type: "thinking-indicator";
};

export type ChatPendingMessageItem = {
  type: "pending-message";
  pending: PendingChatSend;
};

export type ChatTimelineItem = MessageOrGroup | ChatThinkingIndicatorItem | ChatPendingMessageItem;

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
  pending?: PendingChatSend,
): ChatTimelineItem[] {
  const showThinking = shouldShowChatThinkingIndicator(sessionStatus, messages);
  if (!showThinking && !pending) return grouped;
  const visibleItems = showThinking
    ? grouped.filter(
        (item) => item.type !== "single" || !isEmptyStreamingAssistantText(item.msg),
      )
    : grouped;
  return [
    ...visibleItems,
    ...(pending ? [{ type: "pending-message" as const, pending }] : []),
    ...(showThinking ? [THINKING_INDICATOR_ITEM] : []),
  ];
}
