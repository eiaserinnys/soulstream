/**
 * DashboardLayout - 3패널 레이아웃 (리사이즈 가능)
 *
 * SessionList | NodeGraph | RightPanel (Detail + Chat) 구성.
 * SSE 구독, 세션 목록 폴링, 브라우저 알림을 여기서 초기화합니다.
 *
 * composing 모드에서는 중앙 패널에 PromptComposer를 표시합니다.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { SessionList } from "./components/SessionList";
import { NodeGraph } from "./components/NodeGraph";
import { PromptComposer } from "./components/PromptComposer";
import { StorageModeToggleCompact } from "./components/StorageModeToggle";
import { ThemeToggle } from "./components/ThemeToggle";
import { useSessionListProvider } from "./hooks/useSessionListProvider";
import { useSessionProvider } from "./hooks/useSessionProvider";
import { useNotification } from "./hooks/useNotification";
import { useUrlSync } from "./hooks/useUrlSync";
import { useDashboardConfig } from "./hooks/useDashboardConfig";
import { useServerStatus } from "./hooks/useServerStatus";
import {
  RightPanel,
  ChatView,
  initTheme,
  useIsMobile,
  useDashboardStore,
  cn,
  Badge,
  Sheet, SheetContent, SheetFooter,
  Button,
} from "@seosoyoung/soul-ui";
import { Menu } from "lucide-react";

// === Constants ===

/** 패널 기본 비율 (%) */
const DEFAULT_LEFT = 20;
const DEFAULT_RIGHT = 30;

/** 패널 최소/최대 비율 (%) */
const MIN_PANEL = 10;
const MIN_CENTER = 20;

// === Drag Handle ===

function DragHandle({
  onDrag,
}: {
  onDrag: (deltaPercent: number) => void;
}) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const lineRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastX.current = e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const dx = ev.clientX - lastX.current;
        lastX.current = ev.clientX;
        const containerWidth = document.documentElement.clientWidth;
        if (containerWidth > 0) {
          onDragRef.current((dx / containerWidth) * 100);
        }
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 cursor-col-resize bg-transparent shrink-0 relative z-10"
    >
      <div
        className="absolute inset-y-0 -left-[3px] -right-[3px]"
        onMouseEnter={() => {
          if (lineRef.current) {
            lineRef.current.style.backgroundColor = "var(--node-user)";
            lineRef.current.style.opacity = "0.5";
          }
        }}
        onMouseLeave={() => {
          if (lineRef.current) {
            lineRef.current.style.backgroundColor = "var(--border)";
            lineRef.current.style.opacity = "1";
          }
        }}
      >
        <div
          ref={lineRef}
          className="absolute inset-y-0 left-[3px] w-px transition-colors duration-150 bg-border"
        />
      </div>
    </div>
  );
}

// === Connection Status Badge ===

const CONNECTION_CONFIG = {
  disconnected: { label: "Idle", variant: "outline" as const, dotClass: "bg-muted-foreground" },
  connecting: { label: "Connecting...", variant: "warning" as const, dotClass: "bg-accent-amber" },
  connected: { label: "Live", variant: "success" as const, dotClass: "bg-success" },
  error: { label: "Reconnecting...", variant: "error" as const, dotClass: "bg-accent-red" },
};

function ConnectionBadge({
  status,
}: {
  status: "disconnected" | "connecting" | "connected" | "error";
}) {
  const config = CONNECTION_CONFIG[status];
  const shouldPulse = status === "connected" || status === "connecting";

  return (
    <Badge data-testid="connection-badge" variant={config.variant} size="sm">
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          config.dotClass,
          shouldPulse && "animate-[pulse_2s_infinite]",
        )}
      />
      {config.label}
    </Badge>
  );
}

// === Main Layout ===

export function DashboardLayout() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setSerendipityAvailable = useDashboardStore((s) => s.setSerendipityAvailable);

  // 세션 목록 구독 (SSE 모드: 실시간, Serendipity 모드: 폴링)
  const { sessions, loading, error } = useSessionListProvider({ intervalMs: 5000 });

  // 활성 세션 구독 (Provider 기반)
  const { status: sseStatus } = useSessionProvider({
    sessionKey: activeSessionKey,
  });

  // 테마 초기화 (localStorage → OS 설정 → dark 기본)
  useEffect(() => { initTheme(); }, []);

  // 브라우저 알림 (완료/에러/인터벤션)
  useNotification();

  // URL ↔ 스토어 동기화 (/{sessionId} 라우팅)
  useUrlSync();

  // 대시보드 프로필 설정 로드
  useDashboardConfig();

  // Soul Server 드레이닝 상태 폴링 (3초 간격)
  const { isDraining } = useServerStatus();

  // 서버 설정 로드 (세렌디피티 가용 여부)
  useEffect(() => {
    fetch("/api/config")
      .then((res) => {
        if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
        return res.json();
      })
      .then((config: { serendipityAvailable?: boolean }) => {
        setSerendipityAvailable(!!config.serendipityAvailable);
      })
      .catch(() => {
        // config 로드 실패 시 기본값 유지 (false)
      });
  }, [setSerendipityAvailable]);

  // 패널 비율 상태 (%)
  const [leftPercent, setLeftPercent] = useState(DEFAULT_LEFT);
  const [rightPercent, setRightPercent] = useState(DEFAULT_RIGHT);

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

  // PC 전환 시 Sheet 닫힘
  useEffect(() => {
    if (!isMobile) { setIsSidebarOpen(false); }
  }, [isMobile]);

  // 세션 선택 시 Sheet 자동 닫힘
  useEffect(() => {
    if (activeSessionKey && isMobile) { setIsSidebarOpen(false); }
  }, [activeSessionKey, isMobile]);

  // 중앙 패널 렌더링 결정: 세션 미선택 시 항상 Composer 표시
  const showComposer = !activeSessionKey;
  const hasActiveSession = !!activeSessionKey;

  const centerPercent = Math.max(MIN_CENTER, 100 - leftPercent - rightPercent);

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
            Soul Dashboard
          </span>
        </div>
        {!isMobile && (
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <StorageModeToggleCompact />
            <ConnectionBadge status={sseStatus} />
          </div>
        )}
      </header>

      {/* Draining 배너: 서버 재시작 중일 때 표시 */}
      {isDraining && (
        <div
          role="status"
          className="flex items-center justify-center px-4 py-1.5 text-sm font-medium bg-accent-amber text-black shrink-0"
        >
          서버가 재시작 중입니다. 재시작 완료 후 세션이 자동으로 재개됩니다.
        </div>
      )}

      {isMobile ? (
        <>
          {/* 모바일: Sheet 슬라이드 사이드바 */}
          <Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
            <SheetContent side="left" showCloseButton={false}>
              <SessionList sessions={sessions} loading={loading} error={error} />
              <SheetFooter className="border-t border-border p-3 flex flex-row items-center gap-2">
                <ThemeToggle />
                <StorageModeToggleCompact />
                <ConnectionBadge status={sseStatus} />
              </SheetFooter>
            </SheetContent>
          </Sheet>
          {/* 모바일: 단일 메인 뷰 */}
          <main data-testid="mobile-main" className="flex-1 overflow-hidden flex flex-col">
            {showComposer && <PromptComposer />}
            {hasActiveSession && <ChatView />}
          </main>
        </>
      ) : (
        /* 데스크탑: 3-Panel content */
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Session List */}
          <aside
            data-testid="session-panel"
            className="overflow-hidden"
            style={{ width: `${leftPercent}%` }}
          >
            <SessionList sessions={sessions} loading={loading} error={error} />
          </aside>

          {/* Left drag handle */}
          <DragHandle onDrag={handleLeftDrag} />

          {/* Center: Context-dependent content */}
          <main
            data-testid="graph-panel"
            className="overflow-hidden flex flex-col"
            style={{ width: `${centerPercent}%` }}
          >
            {showComposer && (
              <PromptComposer />
            )}

            {hasActiveSession && (
              <div className="flex-1 overflow-hidden">
                <NodeGraph />
              </div>
            )}

          </main>

          {/* Right drag handle */}
          <DragHandle onDrag={handleRightDrag} />

          {/* Right: Detail + Chat */}
          <aside
            data-testid="detail-panel"
            className="overflow-hidden"
            style={{ width: `${rightPercent}%` }}
          >
            <RightPanel />
          </aside>
        </div>
      )}
    </div>
  );
}
