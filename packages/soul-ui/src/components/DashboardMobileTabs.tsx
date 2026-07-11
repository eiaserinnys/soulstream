import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, MessageSquare } from "lucide-react";

import { useDashboardStore, type MobileTab } from "../stores/dashboard-store";
import { Button } from "./ui/button";
import { Tabs, TabsPanel } from "./ui/tabs";
import { FolderStack } from "./dashboard/FolderStack";
import {
  BottomTabBar,
  DEFAULT_DASHBOARD_MOBILE_TABS,
  type DashboardMobileTab,
} from "./BottomTabBar";

export interface DashboardMobileTabsProps {
  tabs?: readonly DashboardMobileTab[];
  leftPanelContent: ReactNode;
  centerPanel: ReactNode;
  rightPanel: ReactNode;
  mobileSessionsView?: ReactNode;
  mobileFolderContents?: ReactNode;
  mobileRunbooksView?: ReactNode;
  mobileChatView?: ReactNode;
  mobileChatHeader?: (onBack: () => void) => ReactNode;
  mobileSettingsContent?: ReactNode;
  onNewSession?: () => void;
}

export function DashboardMobileTabs({
  tabs,
  leftPanelContent,
  centerPanel,
  rightPanel,
  mobileSessionsView,
  mobileFolderContents,
  mobileRunbooksView,
  mobileChatView,
  mobileChatHeader,
  mobileSettingsContent,
  onNewSession,
}: DashboardMobileTabsProps) {
  const activeTab = useDashboardStore((state) => state.activeTab);
  const setActiveTab = useDashboardStore((state) => state.setActiveTab);
  const activeSessionKey = useDashboardStore((state) => state.activeSessionKey);
  const selectedFolderId = useDashboardStore((state) => state.selectedFolderId);
  const catalog = useDashboardStore((state) => state.catalog);
  const clearSelectedFolder = useDashboardStore((state) => state.clearSelectedFolder);
  const setViewMode = useDashboardStore((state) => state.setViewMode);
  const resolvedTabs = useMemo(
    () => validateMobileTabs(tabs ?? DEFAULT_DASHBOARD_MOBILE_TABS),
    [tabs],
  );
  const visibleTabIds = useMemo(
    () => new Set(resolvedTabs.map((tab) => tab.id)),
    [resolvedTabs],
  );
  const normalizedActiveTab = visibleTabIds.has(activeTab)
    ? activeTab
    : resolvedTabs[0]!.id;
  const [previousTab, setPreviousTab] = useState<MobileTab>(normalizedActiveTab);

  useEffect(() => {
    if (normalizedActiveTab !== "chat") setPreviousTab(normalizedActiveTab);
  }, [normalizedActiveTab]);

  useEffect(() => {
    if (activeTab !== normalizedActiveTab) setActiveTab(normalizedActiveTab);
  }, [activeTab, normalizedActiveTab, setActiveTab]);

  const handleTabChange = useCallback((value: unknown) => {
    if (value == null) return;
    const tabId = value as MobileTab;
    if (!visibleTabIds.has(tabId)) return;
    setActiveTab(tabId);
    if (tabId === "feed") {
      clearSelectedFolder();
    } else if (tabId === "folder") {
      useDashboardStore.setState({ selectedFolderId: null });
    } else if (tabId === "runbooks") {
      setViewMode("runbooks");
    }
  }, [clearSelectedFolder, setActiveTab, setViewMode, visibleTabIds]);

  return (
    <Tabs
      value={normalizedActiveTab}
      onValueChange={handleTabChange}
      className="mobile-tabs relative z-10 flex flex-col flex-1 overflow-hidden gap-0"
    >
      <main data-testid="mobile-main" className="flex-1 overflow-hidden relative bg-transparent">
        {visibleTabIds.has("feed") ? (
          <TabsPanel value="feed" keepMounted className="h-full">
            {mobileSessionsView ?? centerPanel}
          </TabsPanel>
        ) : null}

        {visibleTabIds.has("folder") ? (
          <TabsPanel value="folder" keepMounted className="h-full">
            <FolderStack
              selectedFolderId={selectedFolderId}
              leftPanelContent={leftPanelContent}
              mobileFolderContents={mobileFolderContents}
              folderName={catalog?.folders?.find((folder) => folder.id === selectedFolderId)?.name ?? "세션"}
              onBack={() => clearSelectedFolder()}
              onNewSession={onNewSession}
            />
          </TabsPanel>
        ) : null}

        {visibleTabIds.has("runbooks") ? (
          <TabsPanel value="runbooks" keepMounted className="h-full">
            {mobileRunbooksView ?? centerPanel}
          </TabsPanel>
        ) : null}

        {visibleTabIds.has("chat") ? (
          <TabsPanel value="chat" keepMounted className="h-full flex flex-col">
            {activeSessionKey ? (
              <>
                {mobileChatHeader
                  ? mobileChatHeader(() => setActiveTab(previousTab))
                  : <DefaultMobileChatHeader onBack={() => setActiveTab(previousTab)} />}
                {mobileChatView ?? rightPanel}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center p-8 text-center text-muted-foreground">
                <div>
                  <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="text-base">피드 또는 폴더에서<br />세션을 선택하세요</p>
                </div>
              </div>
            )}
          </TabsPanel>
        ) : null}

        {visibleTabIds.has("settings") ? (
          <TabsPanel value="settings" keepMounted className="h-full overflow-y-auto">
            {mobileSettingsContent}
          </TabsPanel>
        ) : null}
      </main>

      <BottomTabBar tabs={resolvedTabs} />
    </Tabs>
  );
}

function DefaultMobileChatHeader({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 h-[44px] border-b border-glass-border glass-strong glass-chrome glass-shadow-xs shrink-0">
      <Button
        variant="ghost"
        size="icon"
        onClick={onBack}
        data-testid="mobile-back-button"
      >
        <ArrowLeft className="h-5 w-5" />
      </Button>
    </div>
  );
}

function validateMobileTabs(tabs: readonly DashboardMobileTab[]): readonly DashboardMobileTab[] {
  if (tabs.length === 0) throw new Error("DashboardShell mobileTabs must not be empty");
  const seen = new Set<MobileTab>();
  for (const tab of tabs) {
    if (seen.has(tab.id)) throw new Error(`DashboardShell mobileTabs contains duplicate ${tab.id}`);
    if (!tab.label.trim()) throw new Error(`DashboardShell mobileTabs ${tab.id} requires a label`);
    seen.add(tab.id);
  }
  return tabs;
}
