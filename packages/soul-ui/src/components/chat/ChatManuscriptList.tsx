import { forwardRef } from "react";
import type { ListProps } from "react-virtuoso";
import type { MessageOrGroup } from "../../lib/grouping";
import type { ChatTimelineItem } from "./ChatView.thinking-indicator";

/** Keep user spacing inside Virtuoso's measured box, including optimistic sends. */
export const MANUSCRIPT_USER_ROW_CLASS_NAME = "pt-10 pb-5 ms-12 flex justify-end";
export const MANUSCRIPT_ADJACENT_USER_ROW_CLASS_NAME = "contents [&_[data-chat-manuscript-user-row]]:pt-5";

function narrationAnchor(item: ChatTimelineItem | undefined) {
  return item?.type === "summary-group" ? item.anchor : item;
}

export function isManuscriptNarration(
  item: ChatTimelineItem,
  next: ChatTimelineItem | undefined,
): boolean {
  const current = narrationAnchor(item);
  if (current?.type !== "single") return false;
  if (
    current.msg.role !== "assistant"
    || (current.msg.treeNodeType !== "text" && current.msg.treeNodeType !== "assistant_message")
    || current.msg.ui !== undefined
  ) {
    return false;
  }

  const nextAnchor = narrationAnchor(next);
  if (nextAnchor?.type === "activity-group" || nextAnchor?.type === "tool-group") return true;
  return nextAnchor?.type === "single" && (
    nextAnchor.msg.role === "tool"
    || (nextAnchor.msg.role === "assistant" && nextAnchor.msg.treeNodeType === "thinking")
  );
}

/**
 * 작업 세부가 꺼져 activity-group을 지운 뒤에도, 그 앞 응답이 서술(작은 보조 글)로
 * 남도록 treeNodeId를 모은다. 판정 규칙은 isManuscriptNarration과 같다.
 */
export function manuscriptActivityNarrationIds(items: readonly MessageOrGroup[]): Set<string> {
  const ids = new Set<string>();
  for (let index = 0; index < items.length - 1; index += 1) {
    const next = items[index + 1];
    if (next.type !== "activity-group") continue;
    if (!isManuscriptNarration(items[index], next)) continue;
    const anchor = narrationAnchor(items[index]);
    if (anchor?.type === "single") ids.add(anchor.msg.treeNodeId);
  }
  return ids;
}

function isUserRow(item: ChatTimelineItem | undefined): boolean {
  return item?.type === "pending-message"
    || (item?.type === "single" && (item.msg.role === "user" || item.msg.role === "intervention"));
}

export function manuscriptItemSpacingClass(item: ChatTimelineItem, previous: ChatTimelineItem | undefined): string {
  // Former adjacent margins collapsed to mt-10. Preserve that gap using pb-5 + pt-5.
  // Read the previous data row, so virtual unmounting cannot change the spacing.
  return isUserRow(item) && isUserRow(previous)
    ? MANUSCRIPT_ADJACENT_USER_ROW_CLASS_NAME
    : "contents";
}

/** Virtuoso's absolute viewport owns width; its measured list owns insets. */
export const ChatManuscriptList = forwardRef<HTMLDivElement, ListProps & { context?: unknown }>(
  function ChatManuscriptList({ context: _context, ...props }, ref) {
    return <div {...props} ref={ref} className="px-1" />;
  },
);

export function ChatManuscriptFooter() {
  return <div data-slot="chat-manuscript-list-footer" className="h-7" aria-hidden="true" />;
}
