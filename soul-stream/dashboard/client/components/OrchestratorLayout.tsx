/**
 * OrchestratorLayout — 메인 레이아웃.
 * TopBar + (NodesPanel | ChatPanel).
 * 고정 비율: 좌 65% / 우 35%.
 */

import { useEffect } from "react";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { TopBar } from "./TopBar";
import { NodesPanel } from "./NodesPanel";
import { ChatPanel } from "./ChatPanel";
import { useNodes } from "../hooks/useNodes";
import { useSessions } from "../hooks/useSessions";

export function OrchestratorLayout() {
  // soul-ui 스토리지 모드: SSE (오케스트레이터는 항상 SSE)
  useEffect(() => {
    useDashboardStore.getState().setStorageMode("sse");
  }, []);

  // SSE 훅 활성화
  useNodes();
  useSessions();

  return (
    <div className="w-screen h-screen flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Nodes Panel */}
        <div className="w-[65%] flex flex-col overflow-hidden">
          <NodesPanel />
        </div>

        {/* Right: Chat Panel */}
        <div className="w-[35%] flex flex-col bg-popover overflow-hidden">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
