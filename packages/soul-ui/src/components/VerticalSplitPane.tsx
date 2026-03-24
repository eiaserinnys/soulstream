/**
 * VerticalSplitPane - 상하 분할 패널
 *
 * 가운데 영역을 상단(FolderContents)과 하단(NodeGraph/PromptComposer)으로 분할.
 * 드래그 가능한 수평 스플릿 바 포함.
 */

import { useState, useRef, useCallback, type ReactNode } from "react";
import { cn } from "../lib/cn";

interface VerticalSplitPaneProps {
  top: ReactNode;
  bottom: ReactNode;
  defaultTopPercent?: number;
  minTopPx?: number;
  minBottomPx?: number;
  className?: string;
}

export function VerticalSplitPane({
  top,
  bottom,
  defaultTopPercent = 40,
  minTopPx = 100,
  minBottomPx = 100,
  className,
}: VerticalSplitPaneProps) {
  const [topPercent, setTopPercent] = useState(defaultTopPercent);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const pct = (y / rect.height) * 100;
      const minTopPct = (minTopPx / rect.height) * 100;
      const minBottomPct = (minBottomPx / rect.height) * 100;
      setTopPercent(Math.max(minTopPct, Math.min(100 - minBottomPct, pct)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [minTopPx, minBottomPx]);

  return (
    <div ref={containerRef} className={cn("flex flex-col h-full", className)}>
      <div style={{ height: `${topPercent}%` }} className="overflow-hidden">
        {top}
      </div>
      <div
        className="h-1 bg-border hover:bg-primary/50 cursor-row-resize shrink-0 transition-colors"
        onMouseDown={onMouseDown}
      />
      <div style={{ height: `${100 - topPercent}%` }} className="overflow-hidden">
        {bottom}
      </div>
    </div>
  );
}
