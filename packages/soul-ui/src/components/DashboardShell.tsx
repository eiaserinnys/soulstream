/**
 * DashboardShell - 3패널 리사이즈 + 모바일 반응형 레이아웃 셸
 *
 * slot props로 내용물을 주입받습니다.
 * 레이아웃 구조만 제공하며, 앱 레벨 훅이나 구체적 컴포넌트는 포함하지 않습니다.
 *
 * 데스크탑: leftPanel | DragHandle | centerPanel | DragHandle | rightPanel
 * 모바일: Sheet(leftPanel) + mobileView에 따른 뷰 전환
 */

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { ArrowLeft, Menu, Search } from "lucide-react";
import { DragHandle } from "./DragHandle";
import { ConnectionBadge, type ConnectionStatus } from "./ConnectionBadge";
import { useIsMobile } from "../hooks/use-mobile";
import { useDashboardStore } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetFooter } from "../components/ui/sheet";

/** 패널 기본 비율 (%) */
const DEFAULT_LEFT = 20;
const DEFAULT_RIGHT = 30;

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
  /** 모바일 채팅 뷰 내용물. 미지정 시 rightPanel 사용 */
  mobileChatView?: ReactNode;
  /**
   * 모바일 채팅 뷰 상단 헤더. 미지정 시 기본 백 버튼만 표시.
   * 세션 정보 등 앱 레벨 내용은 소비자가 이 슬롯으로 주입한다.
   * onMobileBack 콜백을 받아 뒤로가기 동작을 구현할 수 있다.
   */
  mobileChatHeader?: (onBack: () => void) => ReactNode;
  /** 모바일 사이드바 Sheet 하단에 표시할 요소 */
  mobileSheetFooter?: ReactNode;
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
    <div className="flex items-center gap-2 px-2 h-10 border-b border-border bg-popover shrink-0">
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
  mobileChatView,
  mobileChatHeader,
  mobileSheetFooter,
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

  // 모바일 여부 및 사이드바 상태
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const mobileView = useDashboardStore((s) => s.mobileView);
  const setMobileView = useDashboardStore((s) => s.setMobileView);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);

  // PC 전환 시 Sheet 닫힘 + mobileView 리셋
  useEffect(() => {
    if (!isMobile) {
      setIsSidebarOpen(false);
      setMobileView("sessions");
    }
  }, [isMobile, setMobileView]);

  // 세션 선택 시 Sheet 자동 닫힘
  useEffect(() => {
    if (activeSessionKey && isMobile) {
      setIsSidebarOpen(false);
    }
  }, [activeSessionKey, isMobile]);

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
      <header className="flex items-center justify-between px-4 h-10 border-b border-border bg-popover shrink-0">
        <div className="flex items-center gap-3">
          {isMobile && (
            <Button
              data-testid="hamburger-button"
              variant="ghost"
              size="icon"
              onClick={() => setIsSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
          )}
          <span className="text-[14px] font-semibold text-muted-foreground tracking-[0.02em]">
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
          {/* 모바일: Sheet 슬라이드 사이드바 */}
          <Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
            <SheetContent side="left" showCloseButton={false}>
              {leftPanelContent}
              {mobileSheetFooter && (
                <SheetFooter className="border-t border-border p-3 flex flex-row items-center gap-2">
                  {mobileSheetFooter}
                </SheetFooter>
              )}
            </SheetContent>
          </Sheet>
          {/* 모바일: mobileView에 따른 뷰 전환 */}
          <main data-testid="mobile-main" className="flex-1 overflow-hidden flex flex-col">
            {mobileView === "sessions" && (mobileSessionsView ?? centerPanel)}
            {mobileView === "chat" && (
              <>
                {mobileChatHeader
                  ? mobileChatHeader(() => setMobileView("sessions"))
                  : <DefaultMobileChatHeader onBack={() => setMobileView("sessions")} />
                }
                {mobileChatView ?? rightPanel}
              </>
            )}
          </main>
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
