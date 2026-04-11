/**
 * DashboardShell - 3패널 리사이즈 + 모바일 반응형 레이아웃 셸
 *
 * slot props로 내용물을 주입받습니다.
 * 레이아웃 구조만 제공하며, 앱 레벨 훅이나 구체적 컴포넌트는 포함하지 않습니다.
 *
 * 데스크탑: leftPanel | DragHandle | centerPanel | DragHandle | rightPanel
 * 모바일: BottomTabBar + 탭별 콘텐츠 (hidden 방식으로 언마운트 없이 전환)
 */

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, MessageSquare, Search } from "lucide-react";
import { DragHandle } from "./DragHandle";
import { BottomTabBar } from "./BottomTabBar";
import { ConnectionBadge, type ConnectionStatus } from "./ConnectionBadge";
import { useIsMobile } from "../hooks/use-mobile";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";

/** 패널 기본 비율 (%) */
const DEFAULT_LEFT = 20;
const DEFAULT_RIGHT = 40;

/** 패널 최소/최대 비율 (%) */
const MIN_PANEL = 10;
const MIN_CENTER = 20;

export interface DashboardShellProps {
  /** 왼쪽 패널 내용물 (FolderTree 등) */
  leftPanel: ReactNode;
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
  /** 오른쪽 패널 기본 비율 (%). 기본 30 */
  defaultRightPercent?: number;
  /**
   * leftPanel 하단 영역 비율. 기본 0.
   * 0이면 leftPanelBottom 미표시, leftPanel이 전체 높이 사용.
   * 3이면 leftPanel flex-7 : leftPanelBottom flex-3.
   */
  leftBottomRatio?: number;

  /** 모바일 세션 뷰 내용물. 미지정 시 centerPanel 사용 */
  mobileSessionsView?: ReactNode;
  /** 모바일 폴더 탭에서 폴더 선택 후 표시할 세션 목록 뷰 */
  mobileFolderContents?: ReactNode;
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
  leftPanelBottom,
  centerPanel,
  rightPanel,
  title,
  headerRight,
  connectionStatus,
  banner,
  modals,
  defaultLeftPercent = DEFAULT_LEFT,
  defaultRightPercent = DEFAULT_RIGHT,
  leftBottomRatio = 0,
  mobileSessionsView,
  mobileFolderContents,
  mobileChatView,
  mobileChatHeader,
  mobileSettingsContent,
  onSearchClick,
}: DashboardShellProps) {
  // 패널 비율 상태 (%)
  const [leftPercent, setLeftPercent] = useState(defaultLeftPercent);
  const [rightPercent, setRightPercent] = useState(defaultRightPercent);

  // 드래그 중 최신 값을 참조하기 위한 refs (stale closure 방지)
  const leftRef = useRef(leftPercent);
  leftRef.current = leftPercent;
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

  // 채팅 탭 뒤로가기 시 돌아갈 이전 탭 추적
  const [previousTab, setPreviousTab] = useState<typeof activeTab>("feed");
  useEffect(() => {
    if (activeTab !== "chat") {
      setPreviousTab(activeTab);
    }
  }, [activeTab]);

  // PC 전환 시 피드 탭으로 초기화
  useEffect(() => {
    if (!isMobile) {
      setActiveTab("feed");
    }
  }, [isMobile, setActiveTab]);

  const centerPercent = Math.max(MIN_CENTER, 100 - leftPercent - rightPercent);

  // leftPanel에 하단 영역이 있을 때 flex 분할
  const leftPanelContent =
    leftBottomRatio > 0 && leftPanelBottom ? (
      <div className="flex flex-col h-full">
        <div className={cn("overflow-hidden")} style={{ flex: 10 - leftBottomRatio }}>
          {leftPanel}
        </div>
        <div className={cn("overflow-hidden border-t border-border")} style={{ flex: leftBottomRatio }}>
          {leftPanelBottom}
        </div>
      </div>
    ) : (
      leftPanel
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
        <>
          {/* 모바일: 탭별 콘텐츠 */}
          <main data-testid="mobile-main" className="flex-1 overflow-hidden flex flex-col">
            {/* 피드 탭 */}
            <div className={cn("h-full", activeTab !== "feed" && "hidden")}>
              {mobileSessionsView ?? centerPanel}
            </div>

            {/* 폴더 탭 — 모바일에서 폴더 선택 시 2단계 뷰 (트리 → 세션 목록) */}
            <div className={cn("h-full", activeTab !== "folder" && "hidden")}>
              {isMobile && selectedFolderId ? (
                <div className="flex flex-col h-full">
                  <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                    <button
                      onClick={() => clearSelectedFolder()}
                      className="p-1 rounded hover:bg-muted"
                      aria-label="폴더 목록으로 돌아가기"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <span className="text-sm font-medium">
                      {catalog?.folders?.find(f => f.id === selectedFolderId)?.name ?? "세션"}
                    </span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {mobileFolderContents}
                  </div>
                </div>
              ) : (
                leftPanelContent
              )}
            </div>

            {/* 채팅 탭 */}
            <div className={cn("h-full flex flex-col", activeTab !== "chat" && "hidden")}>
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
            </div>

            {/* 설정 탭 */}
            <div className={cn("h-full overflow-y-auto", activeTab !== "settings" && "hidden")}>
              {mobileSettingsContent}
            </div>
          </main>

          {/* 하단 탭바 */}
          <BottomTabBar />
        </>
      ) : (
        /* 데스크탑: 3-Panel content */
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel */}
          <aside
            data-testid="session-panel"
            className="overflow-hidden"
            style={{ width: `${leftPercent}%` }}
          >
            {leftPanelContent}
          </aside>

          {/* Left drag handle */}
          <DragHandle onDrag={handleLeftDrag} />

          {/* Center panel */}
          <main
            data-testid="graph-panel"
            className="overflow-hidden flex flex-col"
            style={{ width: `${centerPercent}%` }}
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
