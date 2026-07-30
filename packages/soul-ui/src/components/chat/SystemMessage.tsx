import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";

export const SystemMessage = memo(function SystemMessage({ msg }: { msg: ChatMessage }) {
  const isError = msg.isError;
  const isComplete = msg.treeNodeType === "complete";
  const isTurnSummary = msg.treeNodeType === "turn_summary";
  const hasCompleteStats = isComplete
    && (msg.usage !== undefined || msg.totalCostUsd !== undefined);
  const isResult = msg.treeNodeType === "result" || !!hasCompleteStats;

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className={cn(
        "flex-1 min-w-0 text-xs px-2 py-1 rounded text-left",
        isTurnSummary && "whitespace-pre-line",
        isError
          ? "chat-tone-danger"
          : isResult
            ? "chat-tone-success"
            : "text-muted-foreground bg-input",
      )}>
        {msg.content}
      </div>
    </div>
  );
});
