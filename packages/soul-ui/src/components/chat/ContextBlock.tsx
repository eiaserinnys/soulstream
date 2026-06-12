import { memo, useMemo, useState } from "react";
import type { ContextItem } from "@shared/types";
import {
  buildContextPromptTokenMetrics,
  formatPromptTokenCount,
} from "../../lib/prompt-token-metrics";
import { ContextContentRenderer } from "../ContextContentRenderer";

/** user_message의 구조화된 맥락 표시 (ToolCallGroup과 동일한 접기/펼치기 스타일) */
export const ContextBlock = memo(function ContextBlock({ items }: { items: ContextItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const metrics = useMemo(() => buildContextPromptTokenMetrics(items), [items]);
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 flex-wrap text-left"
      >
        <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>{"\u{1F4CB}"}</span>
        <span className="font-medium">Context ({items.length})</span>
        <span className="text-xs leading-4 rounded bg-input px-1.5 text-muted-foreground">
          {formatPromptTokenCount(metrics.totalTokens)} prompt
        </span>
      </button>
      {expanded && (
        <div className="ml-4 mt-1 space-y-1.5">
          {items.map((item: ContextItem, index) => (
            <div key={item.key}>
              <div className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5 flex items-center gap-1.5 flex-wrap">
                <span>{item.label}</span>
                <span className="normal-case tracking-normal rounded bg-input px-1.5 leading-4">
                  {formatPromptTokenCount(metrics.items[index]?.tokens ?? 0)} prompt
                </span>
              </div>
              <ContextContentRenderer content={item.content} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
