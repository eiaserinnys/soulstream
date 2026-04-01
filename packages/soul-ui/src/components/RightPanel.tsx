/**
 * RightPanel - 오른쪽 패널 탭 래퍼 (Chat + Detail + Session Info)
 *
 * Chat 탭: SSE 이벤트를 시간순 채팅 로그로 표시 + ChatInput
 * Detail 탭: 기존 DetailView (선택된 노드 상세 정보)
 * Session Info 탭: 세션 메타데이터 실시간 표시
 *
 * 탭 상태는 전역 스토어에서 관리 (노드 클릭 시 Detail 자동 전환을 위해).
 */

import { useCallback } from "react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "./ui/tabs";
import { DetailView } from "./DetailView";
import { ChatView } from "./ChatView";
import { SessionInfoView } from "./SessionInfoView";
import { useDashboardStore } from "../stores/dashboard-store";

const TAB_VALUES = { chat: 0, detail: 1, info: 2 } as const;
const TAB_FROM_INDEX: Array<"chat" | "detail" | "info"> = ["chat", "detail", "info"];

interface RightPanelProps {
  chatInputDisabled?: boolean;
  isOtherNodeSession?: boolean;
}
export function RightPanel({ chatInputDisabled = false, isOtherNodeSession = false }: RightPanelProps = {}) {
  const activeRightTab = useDashboardStore((s) => s.activeRightTab);
  const setActiveRightTab = useDashboardStore((s) => s.setActiveRightTab);

  const handleTabChange = useCallback(
    (value: number | null) => {
      if (value !== null && value in TAB_FROM_INDEX) {
        setActiveRightTab(TAB_FROM_INDEX[value]);
      }
    },
    [setActiveRightTab],
  );

  return (
    <div data-testid="detail-panel-tabs" className="flex flex-col h-full overflow-hidden">
      <Tabs
        value={TAB_VALUES[activeRightTab]}
        onValueChange={handleTabChange}
        className="flex flex-col h-full gap-0"
      >
        <TabsList
          variant="underline"
          className="shrink-0 px-2 border-b border-border w-full"
        >
          <TabsTab value={0} className="text-sm h-8 px-3">Chat</TabsTab>
          <TabsTab value={1} className="text-sm h-8 px-3">Detail</TabsTab>
          <TabsTab value={2} className="text-sm h-8 px-3">Session Info</TabsTab>
        </TabsList>

        <TabsPanel value={0} className="flex-1 overflow-hidden" keepMounted>
          <ChatView chatInputDisabled={chatInputDisabled} isOtherNodeSession={isOtherNodeSession} />
        </TabsPanel>

        <TabsPanel value={1} className="flex-1 overflow-hidden" keepMounted>
          <DetailView />
        </TabsPanel>

        <TabsPanel value={2} className="flex-1 overflow-hidden" keepMounted>
          <SessionInfoView />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
