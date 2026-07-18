/**
 * DashboardShell - 3패널 리사이즈 + 모바일 반응형 레이아웃 셸
 * Size exception: legacy layout shell owns desktop chrome, mobile tabs, and pane persistence.
 *
 * slot props로 내용물을 주입받습니다.
 * 레이아웃 구조만 제공하며, 앱 레벨 훅이나 구체적 컴포넌트는 포함하지 않습니다.
 *
 * 데스크탑: floating toolbar + floating left navigation | centerPanel | DragHandle | rightPanel
 * 모바일: base-ui Tabs(keepMounted) + BottomTabBar. inactive 패널은 DOM을 유지한 채 페이드 전환된다.
 */

import { useState, useCallback, useRef, useEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { BookOpenCheck, ChevronLeft, ChevronRight, FolderTree, Newspaper, Search } from "lucide-react";
import { DragHandle } from "./DragHandle";
import type { DashboardMobileTab } from "./BottomTabBar";
import { DashboardMobileTabs } from "./DashboardMobileTabs";
import { ConnectionBadge, type ConnectionStatus } from "./ConnectionBadge";
import { VerticalSplitPane } from "./VerticalSplitPane";
import { WallpaperLayer } from "./WallpaperLayer";
import { LiquidGlassCanvas, LiquidGlassProvider, useGlassSurface } from "./LiquidGlassProvider";
import { useIsMobile } from "../hooks/use-mobile";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { useLiquidLens } from "../lib/liquid-lens";
import { Button } from "../components/ui/button";
import {
  clampDashboardLeftSidebarWidth,
  DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH,
  isDashboardSidebarToggleShortcut,
  isEditableShortcutTarget,
  readDashboardLeftSidebarCollapsed,
  readDashboardLeftSidebarWidth,
  writeDashboardLeftSidebarCollapsed,
  writeDashboardLeftSidebarWidth,
} from "./dashboard-sidebar-collapse";
import { DASHBOARD_PANEL_GAP_PX } from "./dashboard-spacing";

/** 패널 기본 비율 (%) */
const DEFAULT_RIGHT = 34.5;

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
  /** 배너 배치. 기본값은 기존 헤더 아래 content 위치다. */
  bannerPlacement?: "content" | "viewport-top";
  /** 레이아웃 밖에 렌더링할 모달 */
  modals?: ReactNode;

  /** @deprecated 데스크톱 사이드바는 Liquid Glass v2.2에서 264px 고정 폭을 사용한다. */
  defaultLeftPercent?: number;
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
  /** 모바일 하단 탭과 panel inventory. 미지정 시 기존 5탭을 그대로 사용한다. */
  mobileTabs?: readonly DashboardMobileTab[];
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

export function DashboardShell(props: DashboardShellProps) {
  return (
    <LiquidGlassProvider renderDefaultCanvas={false}>
      <DashboardShellContent {...props} />
    </LiquidGlassProvider>
  );
}

function DashboardShellContent({
  leftPanel,
  leftFeedPanel,
  leftPanelBottom,
  centerPanel,
  rightPanel,
  title,
  headerRight,
  connectionStatus,
  banner,
  bannerPlacement = "content",
  modals,
  defaultRightPercent = DEFAULT_RIGHT,
  leftBottomRatio = 0,
  leftSplitStorageKey,
  mobileSessionsView,
  mobileTabs,
  mobileFolderContents,
  mobileTasksView,
  mobileChatView,
  mobileChatHeader,
  mobileSettingsContent,
  onSearchClick,
  onNewSession,
}: DashboardShellProps) {
  // 패널 비율 상태 (%)
  const [rightPercent, setRightPercent] = useState(defaultRightPercent);
  const brandCapsuleRef = useRef<HTMLDivElement>(null);
  const searchCapsuleRef = useRef<HTMLButtonElement>(null);
  const statusCapsuleRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const centerPanelRef = useRef<HTMLElement>(null);
  const rightPanelRef = useRef<HTMLElement>(null);
  const brandWebglActive = useGlassSurface(brandCapsuleRef, { enabled: true });
  const searchWebglActive = useGlassSurface(searchCapsuleRef, { enabled: true });
  const statusWebglActive = useGlassSurface(statusCapsuleRef, { enabled: true });
  const sidebarWebglActive = useGlassSurface(sidebarRef, { enabled: true });
  const centerPanelWebglActive = useGlassSurface(centerPanelRef, { enabled: true });
  const rightPanelWebglActive = useGlassSurface(rightPanelRef, { enabled: true });
  // The SVG lens fallback is tuned for compact capsules. Large panels keep the
  // normal CSS glass fallback to avoid center-pull distortion on wide surfaces.
  useLiquidLens(brandCapsuleRef, { scale: 48, enabled: !brandWebglActive });
  useLiquidLens(searchCapsuleRef, { scale: 48, enabled: !searchWebglActive });
  useLiquidLens(statusCapsuleRef, { scale: 48, enabled: !statusWebglActive });

  const handleRightDrag = useCallback(
    (delta: number) => {
      setRightPercent((prev) => {
        const maxRight = 100 - MIN_CENTER;
        return Math.max(MIN_PANEL, Math.min(maxRight, prev - delta));
      });
    },
    [],
  );

  const isMobile = useIsMobile();
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const setViewMode = useDashboardStore((s) => s.setViewMode);
  const leftNavigationMode = useDashboardStore((s) => s.leftNavigationMode);
  const setLeftNavigationMode = useDashboardStore((s) => s.setLeftNavigationMode);
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(() => readDashboardLeftSidebarCollapsed());
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() => readDashboardLeftSidebarWidth());
  const leftSidebarWidthRef = useRef(leftSidebarWidth);
  const hasLeftFeedPanel = leftFeedPanel != null;

  useEffect(() => {
    leftSidebarWidthRef.current = leftSidebarWidth;
  }, [leftSidebarWidth]);

  const toggleLeftSidebarCollapsed = useCallback(() => {
    setIsLeftSidebarCollapsed((previous) => {
      const next = !previous;
      writeDashboardLeftSidebarCollapsed(next);
      return next;
    });
  }, []);

  const handleLeftSidebarResizeStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = leftSidebarWidthRef.current;
    let lastWidth = startWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      lastWidth = clampDashboardLeftSidebarWidth(startWidth + moveEvent.clientX - startX);
      setLeftSidebarWidth(lastWidth);
    };

    const handleMouseUp = () => {
      writeDashboardLeftSidebarWidth(lastWidth);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

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

  const centerPercent = Math.max(MIN_CENTER, 100 - rightPercent);
  const centerPanelWidth = `calc((100% - ${DASHBOARD_PANEL_GAP_PX}px) * ${centerPercent / 100})`;
  const rightPanelWidth = `calc((100% - ${DASHBOARD_PANEL_GAP_PX}px) * ${rightPercent / 100})`;
  const showLeftNavigationToggle = hasLeftFeedPanel;
  const selectedLeftPanel = leftPanel;
  const visibleLeftSidebarWidth = isLeftSidebarCollapsed
    ? 44
    : leftSidebarWidth || DASHBOARD_LEFT_SIDEBAR_DEFAULT_WIDTH;
  const showConnectionStatus =
    Boolean(activeSessionKey) && connectionStatus != null && connectionStatus !== "connected";
  const leftNavigationPanel = showLeftNavigationToggle ? (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-col gap-1 px-1 pt-9">
        <button
          type="button"
          className={cn(
            "dashboard-sidebar-row w-full",
            viewMode === "feed" && "dashboard-sidebar-row-active",
          )}
          data-testid="left-navigation-feed"
          aria-pressed={viewMode === "feed"}
          onClick={() => {
            setLeftNavigationMode("feed");
            setViewMode("feed");
          }}
        >
          <Newspaper className="h-3.5 w-3.5" />
          <span className="truncate">최근 활동</span>
        </button>
        <button
          type="button"
          className={cn(
            "dashboard-sidebar-row w-full",
            viewMode === "tasks" && "dashboard-sidebar-row-active",
          )}
          data-testid="left-navigation-tasks"
          aria-pressed={viewMode === "tasks"}
          onClick={() => setViewMode("tasks")}
        >
          <BookOpenCheck className="h-3.5 w-3.5" />
          <span className="truncate">업무</span>
        </button>
        <button
          type="button"
          className={cn(
            "dashboard-sidebar-row w-full",
            viewMode === "folder" && leftNavigationMode === "folders" && "dashboard-sidebar-row-active",
          )}
          data-testid="left-navigation-folders"
          aria-pressed={viewMode === "folder" && leftNavigationMode === "folders"}
          onClick={() => {
            setLeftNavigationMode("folders");
            setViewMode("folder");
          }}
        >
          <FolderTree className="h-3.5 w-3.5" />
          <span className="truncate">폴더</span>
        </button>
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
      className="dashboard-shell relative isolate flex flex-col w-screen h-dvh text-foreground font-sans overflow-hidden"
    >
      <WallpaperLayer />
      <LiquidGlassCanvas />
        {isMobile ? (
          <header
            className="relative z-20 flex items-center justify-between px-4 border-b border-glass-border glass-strong glass-chrome glass-shadow-xs shrink-0"
            style={{ height: 'calc(44px + env(safe-area-inset-top, 0px))', paddingTop: 'env(safe-area-inset-top, 0px)' }}
          >
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-muted-foreground">
                {title}
              </span>
            </div>
          </header>
        ) : (
          <header className="dashboard-floating-toolbar">
            <div
              ref={brandCapsuleRef}
              className="dashboard-toolbar-cap dashboard-toolbar-brand border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={brandWebglActive ? "true" : undefined}
            >
              <span aria-hidden="true" className="dashboard-brand-orb" />
              <span className="font-semibold text-foreground">Soulstream</span>
            </div>
            <button
              ref={searchCapsuleRef}
              type="button"
              className="dashboard-toolbar-cap dashboard-toolbar-search border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={searchWebglActive ? "true" : undefined}
              onClick={onSearchClick}
              disabled={!onSearchClick}
              aria-label="Open session search"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">Search sessions</span>
              <kbd>⌘K</kbd>
            </button>
            <div className="dashboard-toolbar-actions">
              {headerRight}
              {showConnectionStatus && (
                <div
                  ref={statusCapsuleRef}
                  className="dashboard-toolbar-cap border border-glass-border glass-strong glass-chrome lg-rim"
                  data-liquid-glass-webgl={statusWebglActive ? "true" : undefined}
                >
                  <ConnectionBadge status={connectionStatus} />
                </div>
              )}
            </div>
          </header>
        )}

      {banner ? (
        <div
          className={cn(
            "shrink-0",
            bannerPlacement === "viewport-top"
              ? "fixed inset-x-0 top-0 z-50"
              : "z-20",
            bannerPlacement === "content"
              && !isMobile
              && "fixed left-[308px] right-[22px] top-[76px]",
          )}
        >
          {banner}
        </div>
      ) : null}

      {isMobile ? (
        <DashboardMobileTabs
          tabs={mobileTabs}
          leftPanelContent={leftPanelContent}
          centerPanel={centerPanel}
          rightPanel={rightPanel}
          mobileSessionsView={mobileSessionsView}
          mobileFolderContents={mobileFolderContents}
          mobileTasksView={mobileTasksView}
          mobileChatView={mobileChatView}
          mobileChatHeader={mobileChatHeader}
          mobileSettingsContent={mobileSettingsContent}
          onNewSession={onNewSession}
        />
      ) : (
        <>
          <aside
            ref={sidebarRef}
            data-testid="session-panel"
            data-collapsed={isLeftSidebarCollapsed ? "true" : "false"}
            className="dashboard-floating-sidebar border border-glass-border glass-strong glass-chrome lg-rim"
            data-liquid-glass-webgl={sidebarWebglActive ? "true" : undefined}
            style={{ width: visibleLeftSidebarWidth }}
          >
            {isLeftSidebarCollapsed ? (
              <div className="flex h-full items-start justify-center pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full"
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
                  className="absolute right-2 top-2 z-20 h-7 w-7 rounded-full text-muted-foreground"
                  data-testid="left-sidebar-toggle"
                  title="Collapse sidebar"
                  onClick={toggleLeftSidebarCollapsed}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 right-0 z-30 w-3 cursor-col-resize"
                  onMouseDown={handleLeftSidebarResizeStart}
                >
                  <div className="absolute inset-y-5 right-0 w-px bg-transparent transition-colors hover:bg-accent-blue/50" />
                </div>
              </>
            )}
          </aside>

          <div
            className="fixed bottom-[22px] right-[22px] z-10 flex overflow-hidden"
            style={{
              top: banner ? 112 : 76,
              left: 22 + visibleLeftSidebarWidth + 22,
            }}
          >
            <main
              ref={centerPanelRef}
              data-testid="graph-panel"
              className="dashboard-center-panel shrink-0 overflow-hidden flex flex-col border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={centerPanelWebglActive ? "true" : undefined}
              style={{ width: centerPanelWidth }}
            >
              {centerPanel}
            </main>

            <DragHandle onDrag={handleRightDrag} widthPx={DASHBOARD_PANEL_GAP_PX} />

            <aside
              ref={rightPanelRef}
              data-testid="detail-panel"
              className="dashboard-chat-panel shrink-0 overflow-hidden border border-glass-border glass-strong glass-chrome lg-rim"
              data-liquid-glass-webgl={rightPanelWebglActive ? "true" : undefined}
              style={{ width: rightPanelWidth }}
            >
              {rightPanel}
            </aside>
          </div>
        </>
      )}
        {modals}
    </div>
  );
}
