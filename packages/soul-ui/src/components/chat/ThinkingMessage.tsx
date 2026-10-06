import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useLazyLoadContent } from "./hooks";
import { CollapsibleContent } from "./CollapsibleContent";
import { ShowFullContentButton } from "./ShowFullContentButton";
import { MarkdownContent } from "../MarkdownContent";

/** thinking 노드: 3줄 미리보기 + 접기/펼치기 + truncation lazy load */
export const ThinkingMessage = memo(function ThinkingMessage({
  msg,
  presentation = "default",
}: {
  msg: ChatMessage;
  presentation?: "default" | "manuscript";
}) {
  const { displayContent, isTruncated, loading, error, loadFullContent } = useLazyLoadContent(msg);

  if (presentation === "manuscript") {
    return (
      <div className="flex" data-slot="chat-message-row" data-tree-node-id={msg.treeNodeId} data-chat-presentation="manuscript">
        <div className="w-full min-w-0 text-foreground">
          <div data-slot="chat-body" className="text-base text-foreground [line-height:1.6] [word-break:keep-all] [overflow-wrap:anywhere]">
            <MarkdownContent content={displayContent ?? msg.content} enableBlockquoteCopy />
          </div>
          {isTruncated && (
            <ShowFullContentButton loading={loading} error={error} onClick={loadFullContent} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <CollapsibleContent content={displayContent ?? msg.content} label={"\u{1F4AD} Thinking"} />
        {isTruncated && (
          <ShowFullContentButton loading={loading} error={error} onClick={loadFullContent} />
        )}
      </div>
    </div>
  );
});
