import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";
import { CollapsibleContent } from "./CollapsibleContent";

export const SystemMessage = memo(function SystemMessage({ msg }: { msg: ChatMessage }) {
  const isError = msg.isError;
  const isComplete = msg.treeNodeType === "complete";
  const hasCompleteStats = isComplete && (msg.usage || msg.totalCostUsd);
  const isResult = msg.treeNodeType === "result" || !!hasCompleteStats;

  // complete 노드: thinking과 동일한 접기/펼치기 컴포넌트 사용
  if (isComplete && !hasCompleteStats && msg.content && msg.content !== "Turn completed") {
    return (
      <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
        <span className="w-8 shrink-0" />
        <div className="flex-1 min-w-0">
          <CollapsibleContent content={msg.content} label={"\u2705 Complete"} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className={cn(
        "flex-1 min-w-0 text-xs px-2 py-1 rounded text-center",
        isError
          ? "text-accent-red bg-accent-red/8"
          : isResult
            ? "text-success bg-success/8"
            : "text-muted-foreground bg-input",
      )}>
        {msg.content}
      </div>
    </div>
  );
});
