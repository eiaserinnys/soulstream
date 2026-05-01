/**
 * VerticalSplitPane - 상하 분할 패널
 *
 * 두 영역을 상하로 분할하고 드래그 가능한 수평 스플릿 바를 제공한다.
 * 가운데 영역(FolderContents/NodeGraph)과 좌측 사이드바(FolderTree/NodePanel)에서 사용.
 *
 * storageKey가 지정되면 localStorage에 분할 비율을 영속화한다.
 * 영속화는 onMouseUp 시점에 1회만 수행 — onMouseMove마다 setItem을 호출하면
 * localStorage가 동기 API라 드래그가 끊긴다.
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
  /**
   * localStorage 키. 지정 시 분할 비율을 영속화한다.
   * 지정하지 않으면 컴포넌트 마운트 동안만 메모리에 유지된다.
   * 같은 origin에서 복수의 인스턴스가 같은 키를 쓰지 않도록 호출자가 관리한다.
   */
  storageKey?: string;
}

export function VerticalSplitPane({
  top,
  bottom,
  defaultTopPercent = 40,
  minTopPx = 100,
  minBottomPx = 100,
  className,
  storageKey,
}: VerticalSplitPaneProps) {
  // lazy initializer로 localStorage에서 1회만 읽는다 (SSR 안전 가드)
  const [topPercent, setTopPercent] = useState<number>(() => {
    if (typeof window === "undefined" || !storageKey) return defaultTopPercent;
    const stored = window.localStorage.getItem(storageKey);
    if (stored == null) return defaultTopPercent;
    const parsed = Number.parseFloat(stored);
    return Number.isFinite(parsed) ? parsed : defaultTopPercent;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    // 드래그 중 마지막 비율을 캡처해 onMouseUp에서 1회 영속화한다
    let lastValue: number | null = null;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const pct = (y / rect.height) * 100;
      const minTopPct = (minTopPx / rect.height) * 100;
      const minBottomPct = (minBottomPx / rect.height) * 100;
      const next = Math.max(minTopPct, Math.min(100 - minBottomPct, pct));
      lastValue = next;
      setTopPercent(next);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // 드래그 종료 시점에 1회만 영속화 (onMouseMove마다 setItem 호출 시 드래그 성능 저하)
      if (typeof window !== "undefined" && storageKey && lastValue != null) {
        window.localStorage.setItem(storageKey, String(lastValue));
      }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [minTopPx, minBottomPx, storageKey]);

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
