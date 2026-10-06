import { forwardRef } from "react";
import type { ListProps } from "react-virtuoso";
import type { ChatTimelineItem } from "./ChatView.thinking-indicator";

/** Keep user spacing inside Virtuoso's measured box, including optimistic sends. */
export const MANUSCRIPT_USER_ROW_CLASS_NAME = "pt-10 pb-5 ms-12 flex justify-end";
export const MANUSCRIPT_ADJACENT_USER_ROW_CLASS_NAME = "contents [&_[data-chat-manuscript-user-row]]:pt-5";

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
