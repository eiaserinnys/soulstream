import { memo, useState } from "react";
import type { ChatMessage } from "../../lib/flatten-tree";
import { cn } from "../../lib/cn";
import { useLazyLoadContent } from "./hooks";
import { ShowFullContentButton } from "./ShowFullContentButton";

/** 그룹 내 개별 tool call 항목 (truncation lazy load 포함) */
const ToolCallItem = memo(function ToolCallItem({ msg }: { msg: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const { displayContent, isTruncated, loading, error, loadFullContent } = useLazyLoadContent(msg);
  const isDone = msg.toolResult !== undefined || msg.toolDurationMs !== undefined;
  const statusIcon = msg.isError ? "\u274C" : isDone ? "\u2705" : "\u{1F528}";

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "text-xs font-mono flex items-center gap-1",
          msg.isError ? "text-accent-red" : "text-muted-foreground",
          "hover:text-foreground",
        )}
      >
        <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{statusIcon}</span>
        <span className="truncate">{msg.content}</span>
      </button>
      {expanded && msg.toolInput && (
        <pre className="text-xs text-muted-foreground bg-input rounded px-2 py-1.5 ml-5 mt-0.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono">
          {typeof msg.toolInput === "string" ? msg.toolInput : JSON.stringify(msg.toolInput, null, 2)}
        </pre>
      )}
      {expanded && displayContent && (
        <div className="ml-5 mt-0.5">
          <pre className={cn(
            "text-xs bg-input rounded px-2 py-1.5 whitespace-pre-wrap break-words overflow-auto max-h-40 font-mono",
            msg.isError ? "text-accent-red/80" : "text-muted-foreground",
          )}>
            {displayContent}
          </pre>
          {isTruncated && (
            <ShowFullContentButton loading={loading} error={error} onClick={loadFullContent} />
          )}
        </div>
      )}
    </div>
  );
});

/** 연속된 tool 메시지를 하나로 묶어 표시하는 그룹 컴포넌트 */
export const ToolCallGroup = memo(function ToolCallGroup({ messages }: { messages: ChatMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = messages.some((m) => m.isError);
  const allDone = messages.every((m) => m.toolResult !== undefined || m.toolDurationMs !== undefined);

  return (
    <div className="flex gap-2 px-3 py-0.5" data-tree-node-id={messages[0].treeNodeId}>
      <span className="w-8 shrink-0" />
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5"
        >
          <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
          <span>{"\u{1F527}"}</span>
          <span className="font-medium">Tool Calls ({messages.length})</span>
          {hasError && <span className="text-accent-red text-xs">{"\u25CF"} error</span>}
          {!hasError && allDone && <span className="text-success text-xs">{"\u25CF"} done</span>}
        </button>
        {expanded && (
          <div className="ml-4 mt-1 space-y-0.5">
            {messages.map((msg) => (
              <ToolCallItem key={msg.id} msg={msg} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
