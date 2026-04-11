import { Activity, Folder, MessageSquare, Settings } from "lucide-react";
import type React from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import type { MobileTab } from "../stores/dashboard-store";
import { cn } from "../lib/cn";

const TABS: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  { id: "feed",     label: "피드",  icon: <Activity className="h-5 w-5" /> },
  { id: "folder",   label: "폴더",  icon: <Folder className="h-5 w-5" /> },
  { id: "chat",     label: "채팅",  icon: <MessageSquare className="h-5 w-5" /> },
  { id: "settings", label: "설정",  icon: <Settings className="h-5 w-5" /> },
];

export function BottomTabBar() {
  const activeTab = useDashboardStore((s) => s.activeTab);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const clearSelectedFolder = useDashboardStore((s) => s.clearSelectedFolder);

  return (
    <nav
      className="flex items-stretch bg-popover border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => {
            setActiveTab(tab.id);
            // 피드 탭 전환 시 viewMode·selectedFolderId를 초기화하여
            // 폴더 선택 상태가 피드 탭에 잔류하지 않도록 한다
            if (tab.id === "feed") clearSelectedFolder();
          }}
          className={cn(
            "flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[52px] text-xs",
            "transition-colors",
            activeTab === tab.id
              ? "text-primary"
              : "text-muted-foreground",
          )}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
