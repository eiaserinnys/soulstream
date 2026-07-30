import { memo } from "react";

import type { ChatMessage } from "../../lib/flatten-tree";

export const TurnSummaryCaption = memo(function TurnSummaryCaption({
  msg,
}: {
  msg: ChatMessage;
}) {
  return (
    <div
      className="flex gap-2 px-3 py-1"
      data-slot="turn-summary-caption"
      data-tree-node-id={msg.treeNodeId}
      role="note"
      aria-label="턴 요약"
    >
      <span className="w-8 shrink-0" />
      <div className="min-w-0 flex-1 break-words whitespace-pre-wrap border-l border-border/60 pl-3 text-xs leading-[18px] text-muted-foreground">
        {msg.content}
      </div>
    </div>
  );
});
