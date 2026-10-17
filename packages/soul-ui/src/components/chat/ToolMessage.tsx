import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";
import { EventTruncationMetadata } from "./EventTruncationMetadata";

/** 단일 tool 메시지 (그룹에 속하지 않는 단독 tool) */
export const ToolMessage = memo(function ToolMessage({ msg, sessionId }: { msg: ChatMessage; sessionId?: string }) {
  return (
    <div className="flex gap-2 px-3 py-0.5" data-slot="chat-tool-row" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className={cn(
          "flex items-center gap-1",
          "text-xs font-mono truncate",
          msg.isError ? "chat-tone-danger-text" : "text-muted-foreground",
        )}>
          <span>{"\u{1F527}"}</span>
          <span className="truncate">{msg.content}</span>
        </div>
        <EventTruncationMetadata
          truncation={msg.toolInputTruncation}
          sessionId={sessionId}
          eventId={msg.eventId}
        />
        <EventTruncationMetadata
          truncation={msg.toolResultTruncation}
          sessionId={sessionId}
          eventId={msg.fullContentEventId ?? msg.eventId}
        />
      </div>
    </div>
  );
});
