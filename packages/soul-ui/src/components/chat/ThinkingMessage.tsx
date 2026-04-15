import { memo } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { useLazyLoadContent } from "./hooks";
import { CollapsibleContent } from "./CollapsibleContent";
import { ShowFullContentButton } from "./ShowFullContentButton";

/** thinking 노드: 3줄 미리보기 + 접기/펼치기 + truncation lazy load */
export const ThinkingMessage = memo(function ThinkingMessage({ msg }: { msg: ChatMessage }) {
  const { displayContent, isTruncated, loading, error, loadFullContent } = useLazyLoadContent(msg);

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
