import { Activity, BookOpenCheck, Folder, MessageSquare, Settings } from "lucide-react";
import type React from "react";
import type { MobileTab } from "../stores/dashboard-store";
import { TabsList, TabsTrigger } from "./ui/tabs";

export interface DashboardMobileTab {
  id: MobileTab;
  label: string;
  icon: React.ReactNode;
}

export const DEFAULT_DASHBOARD_MOBILE_TABS: readonly DashboardMobileTab[] = [
  { id: "feed",     label: "피드",  icon: <Activity className="h-5 w-5" /> },
  { id: "folder",   label: "폴더",  icon: <Folder className="h-5 w-5" /> },
  { id: "runbooks", label: "런북",  icon: <BookOpenCheck className="h-5 w-5" /> },
  { id: "chat",     label: "채팅",  icon: <MessageSquare className="h-5 w-5" /> },
  { id: "settings", label: "설정",  icon: <Settings className="h-5 w-5" /> },
];

/**
 * 모바일 하단 탭바.
 *
 * 외곽 <Tabs> 컨텍스트(DashboardShell의 모바일 분기)의 자손으로 렌더되며,
 * 탭 전환에 따른 사이드 이펙트(clearSelectedFolder 등)는
 * DashboardShell의 onValueChange에서 일괄 처리한다.
 *
 * TabsList 기본 스타일(rounded-lg bg-muted p-0.5)은 하단 탭바에 부적합하므로
 * `!` 프리픽스(Tailwind !important)로 덮어쓴다. TabsPrimitive.Indicator는
 * 활성 탭 위치를 CSS 변수로 자동 추적하므로 추가 처리 없이 슬라이드가 복원된다.
 */
export function BottomTabBar({
  tabs = DEFAULT_DASHBOARD_MOBILE_TABS,
}: {
  tabs?: readonly DashboardMobileTab[];
}) {
  return (
    <nav
      className="bg-popover border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <TabsList
        className="!w-full !flex !rounded-none !bg-transparent !p-0 !gap-0"
      >
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className="!h-auto !border-transparent !px-0 !rounded-none flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[52px] text-xs font-normal text-muted-foreground data-active:text-primary"
          >
            {tab.icon}
            <span>{tab.label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </nav>
  );
}
