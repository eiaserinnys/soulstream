import { forwardRef } from "react";
import type { ListProps } from "react-virtuoso";

/** Virtuoso's absolute viewport owns width; its measured list owns insets. */
export const ChatManuscriptList = forwardRef<HTMLDivElement, ListProps & { context?: unknown }>(
  function ChatManuscriptList({ context: _context, ...props }, ref) {
    return <div {...props} ref={ref} className="px-1" />;
  },
);

export function ChatManuscriptFooter() {
  return <div data-slot="chat-manuscript-list-footer" className="h-7" aria-hidden="true" />;
}
