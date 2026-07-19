import { memo, useState } from "react";

/** 접기/펼치기 가능한 3줄 미리보기 컴포넌트 (thinking, complete 노드 공용) */
export const CollapsibleContent = memo(function CollapsibleContent({
  content,
  label,
}: {
  content: string | null | undefined;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const safeContent = content ?? "";
  const lines = safeContent.split("\n");
  const needsCollapse = lines.length > 3;
  const preview = needsCollapse ? lines.slice(0, 3).join("\n") + "..." : safeContent;

  return (
    <div>
      {needsCollapse ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-sm text-muted-foreground hover:text-foreground mb-0.5 flex items-center gap-1"
        >
          <span className="text-xs">{expanded ? "\u25BC" : "\u25B6"}</span>
          {label}
        </button>
      ) : (
        <span className="text-sm text-muted-foreground mb-0.5 flex items-center gap-1">
          {label}
        </span>
      )}
      <pre data-slot="chat-body" className="text-xs text-muted-foreground bg-input rounded px-2 py-1.5 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono">
        {expanded || !needsCollapse ? safeContent : preview}
      </pre>
    </div>
  );
});
