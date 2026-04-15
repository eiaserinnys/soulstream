import { memo, useState } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";

/** system_message 노드: 시스템 프롬프트 접기/펼치기 */
export const SystemPromptMessage = memo(function SystemPromptMessage({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex gap-2 px-3 py-1" data-tree-node-id={msg.treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5"
        >
          <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span>{"\u2699\uFE0F"}</span>
          <span className="font-medium">시스템 프롬프트</span>
        </button>
        {expanded && (
          <pre className="text-xs text-muted-foreground bg-input rounded px-2 py-1.5 mt-1 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono">
            {msg.content}
          </pre>
        )}
      </div>
    </div>
  );
});
