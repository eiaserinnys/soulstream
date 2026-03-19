/**
 * OrchestratorLayout — 메인 레이아웃.
 * TopBar + (NodesPanel | DragHandle | ChatPanel).
 * 기본 비율: 좌 70% / 우 30%.
 */

import { useState, useCallback } from "react";
import { TopBar } from "./TopBar";
import { NodesPanel } from "./NodesPanel";
import { ChatPanel } from "./ChatPanel";
import { DragHandle } from "./DragHandle";
import { useNodes } from "../hooks/useNodes";
import { useSessions } from "../hooks/useSessions";

const MIN_RIGHT_WIDTH = 280;
const MAX_RIGHT_WIDTH = 600;
const DEFAULT_RIGHT_WIDTH = 360;

export function OrchestratorLayout() {
  // SSE 훅 활성화
  useNodes();
  useSessions();

  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);

  const handleResize = useCallback((deltaX: number) => {
    setRightWidth((prev) => {
      const next = prev - deltaX; // 왼쪽으로 드래그하면 우측 커짐
      return Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, next));
    });
  }, []);

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Nodes Panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <NodesPanel />
        </div>

        <DragHandle onResize={handleResize} />

        {/* Right: Chat Panel */}
        <div
          className="flex flex-col bg-popover overflow-hidden"
          style={{ width: rightWidth, flexShrink: 0 }}
        >
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
