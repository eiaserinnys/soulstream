/**
 * DashboardShell - 3패널 리사이즈 + 모바일 반응형 레이아웃 셸
 *
 * slot props로 내용물을 주입받습니다.
 * 레이아웃 구조만 제공하며, 앱 레벨 훅이나 구체적 컴포넌트는 포함하지 않습니다.
 *
 * 데스크탑: left navigation(Folders/Feeds) | DragHandle | centerPanel | DragHandle | rightPanel
 * 모바일: base-ui Tabs(keepMounted) + BottomTabBar. inactive 패널은 DOM을 유지한 채 페이드 전환된다.
 */

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, FolderTree, MessageSquare, Newspaper, Search } from "lucide-react";
import { DragHandle } from "./DragHandle";
import { BottomTabBar } from "./BottomTabBar";
import { ConnectionBadge, type ConnectionStatus } from "./ConnectionBadge";
import { VerticalSplitPane } from "./VerticalSplitPane";
import { Tabs, TabsPanel } from "./ui/tabs";
import { FolderStack } from "./dashboard/FolderStack";
import { useIsMobile } from "../hooks/use-mobile";
import { useDashboardStore, type MobileTab } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";
import {
  isDashboardSidebarToggleShortcut,
  isEditableShortcutTarget,
  readDashboardLeftSidebarCollapsed,
  writeDashboardLeftSidebarCollapsed,
} from "./dashboard-sidebar-collapse";

/** 패널 기본 비율 (%) */
const DEFAULT_LEFT = 20;
const DEFAULT_RIGHT = 40;

/** 패널 최소/최대 비율 (%) */
const MIN_PANEL = 10;
const MIN_CENTER = 20;

export interface DashboardShellProps {
  /** 왼쪽 패널 내용물 (FolderTree 등) */
  leftPanel: ReactNode;
  /** 데스크톱 좌측 피드 패널. 지정되면 leftPanel과 토글된다. */
  leftFeedPanel?: ReactNode;
  /** 왼쪽 패널 하단 내용물 (NodePanel 등). leftBottomRatio > 0일 때 표시 */
  leftPanelBottom?: ReactNode;
  /** 센터 패널 내용물 */
  centerPanel: ReactNode;
  /** 오른쪽 패널 내용물 (RightPanel 등) */
  rightPanel: ReactNode;

  /** 헤더에 표시할 타이틀 */
  title: string;
  /** 헤더 우측에 표시할 요소 (ThemeToggle, ConfigButton 등) */
  headerRight?: ReactNode;
  /** SSE 연결 상태 */
  connectionStatus?: ConnectionStatus;

  /** 헤더와 메인 영역 사이에 표시할 배너 */
  banner?: ReactNode;
  /** 레이아웃 밖에 렌더링할 모달 */
  modals?: ReactNode;

  /** 왼쪽 패널 기본 비율 (%). 기본 20 */
  defaultLeftPercent?: number;
  /** 데스크톱 왼쪽 패널과 모바일 폴더 트리를 숨길지 여부 */
  hideLeftPanel?: boolean;
  /** 오른쪽 패널 기본 비율 (%). 기본 30 */
  defaultRightPercent?: number;
  /**
   * leftPanel 하단 영역 비율. 기본 0.
   * 0이면 leftPanelBottom 미표시, leftPanel이 전체 높이 사용.
   * 3이면 leftPanel flex-7 : leftPanelBottom flex-3 (초기 비율, 드래그로 조절 가능).
   */
  leftBottomRatio?: number;
  /**
   * 좌측 상하 분할 비율의 localStorage 영속화 키.
   * 미지정 시 영속화 없이 마운트 동안만 메모리에 유지된다.
   * 호출자가 모드별로 다른 키를 주거나, 영속화를 원치 않는 환경(테스트·스토리북)에서는 생략한다.
   */
  leftSplitStorageKey?: string;

  /** 모바일 세션 뷰 내용물. 미지정 시 centerPanel 사용 */
  mobileSessionsView?: ReactNode;
  /** 모바일 폴더 탭에서 폴더 선택 후 표시할 세션 목록 뷰 */
  mobileFolderContents?: ReactNode;
  /** 모바일 Tasks 탭 내용물 */
  mobileTasksView?: ReactNode;
  /** 모바일 채팅 뷰 내용물. 미지정 시 rightPanel 사용 */
  mobileChatView?: ReactNode;
  /**
   * 모바일 채팅 뷰 상단 헤더. 미지정 시 기본 백 버튼만 표시.
   * 세션 정보 등 앱 레벨 내용은 소비자가 이 슬롯으로 주입한다.
   * onMobileBack 콜백을 받아 뒤로가기 동작을 구현할 수 있다.
   */
  mobileChatHeader?: (onBack: () => void) => ReactNode;
  /** 모바일 설정 탭에 표시할 내용물 */
  mobileSettingsContent?: ReactNode;
  /** 모바일 검색 버튼 클릭 콜백. 미지정 시 검색 버튼 표시 안 함 */
  onSearchClick?: () => void;
  /** 모바일 폴더 세션 리스트에서 '새 세션' 버튼 클릭 시 콜백 */
  onNewSession?: () => void;
}

/**
 * DefaultMobileChatHeader - 기본 모바일 채팅 뷰 헤더
 *
 * 백 버튼만 표시합니다. 세션 정보 등 앱 레벨 내용은
 * mobileChatHeader 슬롯으로 주입받습니다.
 */
function DefaultMobileChatHeader({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 h-[44px] border-b border-border bg-popover shrink-0">
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

export function DashboardShell({
  leftPanel,
  leftFeedPanel,
  leftPanelBottom,
  centerPanel,
  rightPanel,
  title,
  headerRight,
  connectionStatus,
  banner,
  modals,
  defaultLeftPercent = DEFAULT_LEFT,
  hideLeftPanel = false,
  defaultRightPercent = DEFAULT_RIGHT,
  leftBottomRatio = 0,
  leftSplitStorageKey,
  mobileSessionsView,
  mobileFolderContents,
  mobileTasksView,
  mobileChatView,
  mobileChatHeader,
  mobileSettingsContent,
  onSearchClick,
  onNewSession,
}: DashboardShellProps) {
  // 패널 비율 상태 (%)
  const [leftPercent, setLeftPercent] = useState(defaultLeftPercent);
  const [rightPercent, setRightPercent] = useState(defaultRightPercent);

  // 드래그 중 최신 값을 참조하기 위한 refs (stale closure 방지)
  const leftRef = useRef(leftPercent);
  leftRef.current = hideLeftPanel ? 0 : leftPercent;
  const rightRef = useRef(rightPercent);
  rightRef.current = rightPercent;

  const handleLeftDrag = useCallback(
    (delta: number) => {
      setLeftPercent((prev) => {
        const maxLeft = 100 - rightRef.current - MIN_CENTER;
        return Math.max(MIN_PANEL, Math.min(maxLeft, prev + delta));
      });
    },
    [],
  );

  const handleRightDrag = useCallback(
    (delta: number) => {
      setRightPercent((prev) => {
        const maxRight = 100 - leftRef.current - MIN_CENTER;
        return Math.max(MIN_PANEL, Math.min(maxRight, prev - delta));
      });
    },
    [],
  );

  const isMobile = useIsMobile();
  const activeTab = useDashboardStore((s) => s.activeTab);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const clearSelectedFolder = useDashboardStore((s) => s.clearSelectedFolder);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const leftNavigationMode = useDashboardStore((s) => s.leftNavigationMode);
  const setLeftNavigationMode = useDashboardStore((s) => s.setLeftNavigationMode);
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(() => readDashboardLeftSidebarCollapsed());
  const hasLeftFeedPanel = leftFeedPanel != null;

  const toggleLeftSidebarCollapsed = useCallback(() => {
    setIsLeftSidebarCollapsed((previous) => {
      const next = !previous;
      writeDashboardLeftSidebarCollapsed(next);
      return next;
    });
  }, []);

  // 채팅 탭 뒤로가기 시 돌아갈 이전 탭 추적
  const [previousTab, setPreviousTab] = useState<typeof activeTab>("feed");
  useEffect(() => {
    if (activeTab !== "chat") {
      setPreviousTab(activeTab);
    }
  }, [activeTab]);

  // PC 전환 시 모바일 탭 상태만 피드로 유지하고, 가운데 표면은 폴더 작업 표면으로 정규화한다.
  useEffect(() => {
    if (!isMobile) {
      const state = useDashboardStore.getState();
      if (state.activeTab !== "feed") setActiveTab("feed");
      if (hasLeftFeedPanel && state.viewMode === "feed") setViewMode("folder");
    }
  }, [hasLeftFeedPanel, isMobile, setActiveTab, setViewMode]);

  useEffect(() => {
    if (isMobile) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableShortcutTarget(event.target) || !isDashboardSidebarToggleShortcut(event)) return;
      event.preventDefault();
      toggleLeftSidebarCollapsed();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, toggleLeftSidebarCollapsed]);

  /**
   * 모바일 탭 변경 핸들러.
   *
   * 기존 BottomTabBar의 onClick 로직(setActiveTab + feed/folder 분기 사이드 이펙트)을
   * base-ui Tabs의 onValueChange 콜백으로 그대로 이동한 것이다.
   *
   * base-ui v1.3.0 `Tabs.Root.onValueChange`는 `(value: TabsTab.Value, eventDetails) => void`로,
   * TabsTab.Value는 `any | null` 타입이다. TABS 배열의 id가 유일한 value이므로
   * 런타임 가드 후 MobileTab으로 좁힌다.
   */
  const handleMobileTabChange = useCallback((value: unknown) => {
    if (value == null) return;
    const tabId = value as MobileTab;
    setActiveTab(tabId);
    if (tabId === "feed") {
      // 피드 탭: viewMode도 함께 초기화 (기존 BottomTabBar L29-32 동작)
      clearSelectedFolder();
    } else if (tabId === "folder") {
      // 폴더 탭: 항상 폴더 리스트에서 시작. viewMode는 건드리지 않아 세션 쿼리가 꼬이지 않게 한다 (기존 BottomTabBar L33-36 동작)
      useDashboardStore.setState({ selectedFolderId: null });
    } else if (tabId === "tasks") {
      setViewMode("tasks");
    }
  }, [setActiveTab, clearSelectedFolder, setViewMode]);

  const centerPercent = Math.max(MIN_CENTER, 100 - (hideLeftPanel ? 0 : leftPercent) - rightPercent);
  const showLeftNavigationToggle = hasLeftFeedPanel;
  const selectedLeftPanel =
    showLeftNavigationToggle && leftNavigationMode === "feed" ? leftFeedPanel : leftPanel;
  const leftNavigationPanel = showLeftNavigationToggle ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-1">
        <Button
          type="button"
          variant={leftNavigationMode === "folders" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 min-w-0 flex-1 gap-1.5 px-2 text-xs"
          data-testid="left-navigation-folders"
          aria-pressed={leftNavigationMode === "folders"}
          onClick={() => setLeftNavigationMode("folders")}
        >
          <FolderTree className="h-3.5 w-3.5" />
          <span className="truncate">Folders</span>
        </Button>
        <Button
          type="button"
          variant={leftNavigationMode === "feed" ? "secondary" : "ghost"}
          size="sm"
          className="h-7 min-w-0 flex-1 gap-1.5 px-2 text-xs"
          data-testid="left-navigation-feed"
          aria-pressed={leftNavigationMode === "feed"}
          onClick={() => setLeftNavigationMode("feed")}
        >
          <Newspaper className="h-3.5 w-3.5" />
          <span className="truncate">Feed</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {selectedLeftPanel}
      </div>
    </div>
  ) : (
    leftPanel
  );

  // leftPanel에 하단 영역이 있을 때 드래그 가능한 상하 분할 (VerticalSplitPane 재사용)
  // leftBottomRatio(0~10) → defaultTopPercent(0~100): leftBottomRatio=3 → top=70%
  // 영속화 키는 호출자가 leftSplitStorageKey로 결정한다 (leftBottomRatio와 정책 소유권 일치).
  const leftPanelContent =
    leftBottomRatio > 0 && leftPanelBottom ? (
      <VerticalSplitPane
        className="h-full"
        top={leftNavigationPanel}
        bottom={leftPanelBottom}
        defaultTopPercent={(10 - leftBottomRatio) * 10}
        minTopPx={120}
        minBottomPx={80}
        storageKey={leftSplitStorageKey}
      />
    ) : (
      leftNavigationPanel
    );

  return (
    <div
      data-testid="dashboard-layout"
      className="flex flex-col w-screen h-dvh bg-background text-foreground font-sans overflow-hidden"
    >
      {/* Top bar */}
      <header
        className="flex items-center justify-between px-4 border-b border-border bg-popover shrink-0"
        style={{ height: 'calc(44px + env(safe-area-inset-top, 0px))', paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold text-muted-foreground">
            {title}
          </span>
        </div>
        {!isMobile && (
          <div className="flex items-center gap-2">
            {onSearchClick && (
              <Button variant="ghost" size="icon" onClick={onSearchClick}>
                <Search className="h-4 w-4" />
              </Button>
            )}
            {headerRight}
            {connectionStatus && <ConnectionBadge status={connectionStatus} />}
          </div>
        )}
      </header>

      {/* Banner */}
      {banner}

      {isMobile ? (
        /**
         * 모바일: base-ui Tabs로 탭 상태·키보드 네비게이션·Indicator 슬라이드를 위임하고,
         * keepMounted로 inactive 패널을 언마운트 없이 유지하여 탭 전환 시 스크롤/상태를 보존한다.
         * [hidden] 패널은 globals.css의 `.mobile-tabs [data-slot="tabs-content"][hidden]` 규칙으로
         * `display:none` 대신 opacity/visibility 페이드로 전환된다.
         */
        <Tabs
          value={activeTab}
          onValueChange={handleMobileTabChange}
          className="mobile-tabs flex flex-col flex-1 overflow-hidden gap-0"
        >
          <main data-testid="mobile-main" className="flex-1 overflow-hidden relative">
            {/* 피드 탭 */}
            <TabsPanel value="feed" keepMounted className="h-full">
              {mobileSessionsView ?? centerPanel}
            </TabsPanel>

            {/* 폴더 탭 — 2단계 네비게이션(폴더 목록 ↔ 폴더 내용)은 FolderStack이 슬라이드로 처리 */}
            <TabsPanel value="folder" keepMounted className="h-full">
              {hideLeftPanel ? (
                mobileFolderContents ?? centerPanel
              ) : (
                <FolderStack
                  selectedFolderId={selectedFolderId}
                  leftPanelContent={leftPanelContent}
                  mobileFolderContents={mobileFolderContents}
                  folderName={catalog?.folders?.find((f) => f.id === selectedFolderId)?.name ?? "세션"}
                  onBack={() => clearSelectedFolder()}
                  onNewSession={onNewSession}
                />
              )}
            </TabsPanel>

            <TabsPanel value="tasks" keepMounted className="h-full">
              {mobileTasksView ?? centerPanel}
            </TabsPanel>

            {/* 채팅 탭 */}
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

            {/* 설정 탭 */}
            <TabsPanel value="settings" keepMounted className="h-full overflow-y-auto">
              {mobileSettingsContent}
            </TabsPanel>
          </main>

          {/* 하단 탭바 — Tabs 컨텍스트 내부에 두어야 TabsTrigger가 동작한다 */}
          <BottomTabBar />
        </Tabs>
      ) : (
        /* 데스크탑: 3-Panel content */
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel */}
          {!hideLeftPanel && (
            <aside
              data-testid="session-panel"
              className="relative overflow-hidden transition-[width] duration-150 ease-out"
              style={{ width: isLeftSidebarCollapsed ? 44 : `${leftPercent}%` }}
            >
              {isLeftSidebarCollapsed ? (
                <div className="flex h-full items-start justify-center pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    data-testid="left-sidebar-toggle"
                    title="Expand sidebar"
                    onClick={toggleLeftSidebarCollapsed}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <>
                  {leftPanelContent}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 z-20 h-7 w-7 bg-popover/80"
                    data-testid="left-sidebar-toggle"
                    title="Collapse sidebar"
                    onClick={toggleLeftSidebarCollapsed}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </>
              )}
            </aside>
          )}

          {/* Left drag handle */}
          {!hideLeftPanel && !isLeftSidebarCollapsed && <DragHandle onDrag={handleLeftDrag} />}

          {/* Center panel */}
          <main
            data-testid="graph-panel"
            className="overflow-hidden flex flex-col"
            style={isLeftSidebarCollapsed && !hideLeftPanel ? { flex: "1 1 auto" } : { width: `${centerPercent}%` }}
          >
            {centerPanel}
          </main>

          {/* Right drag handle */}
          <DragHandle onDrag={handleRightDrag} />

          {/* Right panel */}
          <aside
            data-testid="detail-panel"
            className="overflow-hidden"
            style={{ width: `${rightPercent}%` }}
          >
            {rightPanel}
          </aside>
        </div>
      )}

      {/* Modals */}
      {modals}
    </div>
  );
}
