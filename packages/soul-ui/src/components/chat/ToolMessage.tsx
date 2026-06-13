import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";

/** 단일 tool 메시지 (그룹에 속하지 않는 단독 tool) */
export const ToolMessage = memo(function ToolMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex gap-2 px-3 py-0.5" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className={cn(
        "flex-1 min-w-0 flex items-center gap-1",
        "text-xs font-mono truncate",
        msg.isError ? "chat-tone-danger-text" : "text-muted-foreground",
      )}>
        <span>{"\u{1F527}"}</span>
        <span className="truncate">{msg.content}</span>
      </div>
    </div>
  );
});
