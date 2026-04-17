import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";

/** away_summary (recap) 메시지 — 세션 복귀 시 요약을 표시 */
export const AwaySummaryMessage = memo(function AwaySummaryMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 px-3 py-2" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0 text-sm italic px-3 py-2 rounded bg-muted/60 text-muted-foreground whitespace-pre-wrap">
        <span className="not-italic font-medium">※ recap:</span>{" "}
        {msg.content}
      </div>
    </div>
  );
});
