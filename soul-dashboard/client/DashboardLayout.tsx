/**
 * DashboardLayout - 3패널 레이아웃 (리사이즈 가능)
 *
 * SessionList | NodeGraph + ChatInput | DetailView 구성.
 * SSE 구독, 세션 목록 폴링, 브라우저 알림을 여기서 초기화합니다.
 *
 * composing 모드에서는 중앙 패널에 PromptComposer를 표시합니다.
 */

import { useState, useCallback, useRef } from "react";
import { SessionList } from "./components/SessionList";
import { NodeGraph } from "./components/NodeGraph";
import { DetailView } from "./components/DetailView";
import { ChatInput } from "./components/ChatInput";
import { PromptComposer } from "./components/PromptComposer";
import { useSessionList } from "./hooks/useSessionList";
import { useSession } from "./hooks/useSession";
import { useNotification } from "./hooks/useNotification";
import { useDashboardStore } from "./stores/dashboard-store";
import { cn } from "./lib/cn";
import { Badge } from "./components/ui/badge";

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
          if (lineRef.current) lineRef.current.style.backgroundColor = "rgba(59, 130, 246, 0.5)";
        }}
        onMouseLeave={() => {
          if (lineRef.current) lineRef.current.style.backgroundColor = "rgba(255,255,255,0.06)";
        }}
      >
        <div
          ref={lineRef}
          className="absolute inset-y-0 left-[3px] w-px transition-colors duration-150"
          style={{ backgroundColor: "rgba(255,255,255,0.06)" }}
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
    <Badge variant={config.variant} size="sm">
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

  // 세션 목록 폴링
  const { sessions, loading, error } = useSessionList({ intervalMs: 5000 });

  // 활성 세션 SSE 구독
  const { status: sseStatus } = useSession({
    sessionKey: activeSessionKey,
  });

  // 브라우저 알림 (완료/에러/인터벤션)
  useNotification();

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

  // 중앙 패널 렌더링 결정: 세션 미선택 시 항상 Composer 표시
  const showComposer = !activeSessionKey;
  const showGraph = !!activeSessionKey;

  const centerPercent = Math.max(MIN_CENTER, 100 - leftPercent - rightPercent);

  return (
    <div
      data-testid="dashboard-layout"
      className="flex flex-col w-screen h-screen bg-background text-foreground font-sans overflow-hidden"
    >
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 h-10 border-b border-border bg-popover shrink-0">
        <span className="text-[13px] font-semibold text-muted-foreground tracking-[0.02em]">
          Soul Dashboard
        </span>
        <ConnectionBadge status={sseStatus} />
      </header>

      {/* 3-Panel content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Session List */}
        <aside
          data-testid="session-panel"
          className="shrink-0 overflow-hidden"
          style={{ width: `${leftPercent}%` }}
        >
          <SessionList sessions={sessions} loading={loading} error={error} />
        </aside>

        {/* Left drag handle */}
        <DragHandle onDrag={handleLeftDrag} />

        {/* Center: Context-dependent content */}
        <main
          data-testid="graph-panel"
          className="shrink-0 overflow-hidden flex flex-col"
          style={{ width: `${centerPercent}%` }}
        >
          {showComposer && (
            <PromptComposer />
          )}

          {showGraph && (
            <>
              <div className="flex-1 overflow-hidden">
                <NodeGraph />
              </div>
              <ChatInput />
            </>
          )}

        </main>

        {/* Right drag handle */}
        <DragHandle onDrag={handleRightDrag} />

        {/* Right: Detail View */}
        <aside
          data-testid="detail-panel"
          className="shrink-0 overflow-hidden"
          style={{ width: `${rightPercent}%` }}
        >
          <DetailView />
        </aside>
      </div>
    </div>
  );
}
