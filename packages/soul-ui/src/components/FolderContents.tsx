/**
 * FolderContents - 선택된 폴더의 세션 목록
 *
 * 폴더 내 세션을 가상 스크롤로 표시. DnD/다중선택/인라인편집 지원.
 * API 호출은 콜백 props로 주입받아 앱별 엔드포인트에 의존하지 않는다.
 */

import { useMemo, useRef, useState, useEffect, memo, useCallback } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  useDashboardStore,
  isSessionUnread,
} from "../stores/dashboard-store";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { Badge } from "./ui/badge";
import type { SessionSummary, SessionStatus } from "../shared/types";
import { SessionContextMenu } from "./SessionContextMenu";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { NodeBadge } from "./NodeBadge";
import { filterSessionsInFolder, type SessionPage } from "../hooks/session-stream-helpers";

// === Node ID Color Utils ===

export { nodeIdToHue } from "../lib/nodeColors";

// === Status Config ===

export interface StatusConfig {
  dotClass: string;
  animate: boolean;
}

export const STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  running:      { dotClass: "bg-success",          animate: true  },
  completed:    { dotClass: "bg-muted-foreground",  animate: false },
  error:        { dotClass: "bg-accent-red",        animate: false },
  interrupted:  { dotClass: "bg-accent-amber",      animate: false },
  unknown:      { dotClass: "bg-muted-foreground",  animate: false },
};

function SessionPortrait({ url }: { url: string }) {
  const [error, setError] = useState(false);
  if (error) return null;
  return (
    <div className="h-10 w-10 shrink-0 rounded-full overflow-hidden">
      <img
        src={url}
        alt=""
        className="w-full h-full object-cover"
        onError={() => setError(true)}
      />
    </div>
  );
}

interface SessionItemProps {
  session: SessionSummary;
  isActive: boolean;
  isSelected: boolean;
  isEditing: boolean;
  /** DnD 시 전달할 세션 ID 목록 (다중 선택 포함) */
  dragSessionIds: string[];
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onEditSubmit: (name: string) => void;
  onEditCancel: () => void;
}

const SessionItem = memo(function SessionItem({
  session,
  isActive,
  isSelected,
  isEditing,
  dragSessionIds,
  onClick,
  onContextMenu,
  onEditSubmit,
  onEditCancel,
}: SessionItemProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: session.agentSessionId,
    data: { type: "session", sessionIds: dragSessionIds },
  });

  const config = STATUS_CONFIG[session.status] ?? STATUS_CONFIG.unknown;
  const isUnread = isSessionUnread(session);
  const isReadCompleted = session.status === "completed" && !isUnread;

  const displayText = session.displayName
    ? `📌 ${session.displayName}`
    : session.lastMessage?.preview
      ? `🗨️ ${session.lastMessage.preview}`
      : session.prompt || session.agentSessionId;

  const displayTime = session.lastMessage?.timestamp ?? session.updatedAt ?? session.createdAt;
  const timeStr = displayTime
    ? new Date(displayTime).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "...";

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-testid="draggable-session"
      className={cn(
        "flex items-center gap-2 px-3 py-2 cursor-pointer text-sm hover:bg-accent/50 border-b border-border/50 select-none",
        isActive && "bg-accent text-accent-foreground",
        isSelected && !isActive && "bg-primary/10",
        isReadCompleted && "opacity-50",
        isDragging && "opacity-50",
      )}
      onClick={onClick}
      onContextMenu={onContextMenu}
      data-session-id={session.agentSessionId}
    >
      <span
        className={cn(
          "w-2 h-2 rounded-full shrink-0",
          config.dotClass,
          config.animate && "animate-[pulse_2s_infinite]",
        )}
      />
      {session.agentPortraitUrl && (
        <SessionPortrait url={session.agentPortraitUrl} />
      )}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            autoFocus
            className="w-full bg-transparent border-b border-primary outline-none text-sm"
            defaultValue={session.displayName ?? ""}
            onBlur={(e) => onEditSubmit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEditSubmit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") onEditCancel();
            }}
          />
        ) : (
          <div className={cn("truncate", isUnread ? "text-foreground font-semibold" : isReadCompleted ? "text-muted-foreground" : "text-foreground")}>
            {displayText}
          </div>
        )}
        <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
          {session.agentName && (
            <>
              <span className="shrink-0 text-xs opacity-70">{session.agentName}</span>
              <span className="shrink-0 opacity-50">·</span>
            </>
          )}
          <span>{timeStr}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {session.nodeId && <NodeBadge nodeId={session.nodeId} className="shrink-0" />}
        {session.eventCount > 0 && (
          <Badge variant="outline" size="sm" className="shrink-0">
            {session.eventCount}
          </Badge>
        )}
      </div>
    </div>
  );
});

export interface FolderContentsProps {
  /**
   * 세션을 다른 폴더로 이동하는 콜백.
   * DashboardDndProvider를 사용하는 경우 DndContext의 onDragEnd가 이동을 처리하므로 생략 가능.
   * @deprecated DashboardDndProvider 사용 시 불필요. 레거시 호환 및 직접 이동 트리거용으로 유지.
   */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 UI 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  /** 스크롤 하단 도달 시 다음 페이지 로드 콜백 */
  onLoadMore?: () => void;
  /** 추가 로드 가능 여부 */
  hasMore?: boolean;
}

export function FolderContents({ onMoveSessions, onRenameSession, onLoadMore, hasMore }: FolderContentsProps) {
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const selectedSessionIds = useDashboardStore((s) => s.selectedSessionIds);
  const editingSessionId = useDashboardStore((s) => s.editingSessionId);
  const setEditingSession = useDashboardStore((s) => s.setEditingSession);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const catalog = useDashboardStore((s) => s.catalog);
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  // TanStack Query 캐시 변경 감지: queryCache.subscribe로 cacheVersion 증가 → useMemo 재계산
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      setCacheVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [queryClient]);

  // TanStack Query 캐시에서 전체 세션 추출 → 폴더 필터링
  const displaySessions = useMemo(() => {
    const allData = queryClient.getQueriesData<InfiniteData<SessionPage>>({ queryKey: ["sessions"], exact: false });
    const allSessions: SessionSummary[] = [];
    for (const [, data] of allData) {
      if (!data) continue;
      for (const page of data.pages) allSessions.push(...page.sessions);
    }
    return filterSessionsInFolder(allSessions, catalog, selectedFolderId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, catalog, selectedFolderId, queryClient]);

  // 폴더 전환 시 자동 세션 선택 (모바일 제외)
  // ⚠️ !isMobile 조건 필수 — 모바일에서는 폴더 탭 2단계 뷰를 유지해야 함
  // (기존 selectFolder의 skipAutoSelect: isMobile 동작 대체)
  useEffect(() => {
    if (!isMobile && displaySessions.length > 0 && !activeSessionKey) {
      setActiveSession(displaySessions[0].agentSessionId);
      setActiveSessionSummary(displaySessions[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolderId]);

  const parentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver: 스크롤 하단 도달 시 다음 페이지 로드
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore]);

  const virtualizer = useVirtualizer({
    count: displaySessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const { setRef } = useFlipAnimation(displaySessions, virtualItems);

  const handleContextMenu = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
    },
    [],
  );

  const handleEditSubmit = useCallback(
    async (sessionId: string, name: string) => {
      const displayName = name.trim() || null;
      setEditingSession(null);
      if (onRenameSession) {
        await onRenameSession(sessionId, displayName);
      }
    },
    [setEditingSession, onRenameSession],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "F2" && activeSessionKey && onRenameSession) {
        setEditingSession(activeSessionKey);
      }
    },
    [activeSessionKey, setEditingSession, onRenameSession],
  );

  return (
    <>
      {displaySessions.length === 0 ? (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          No sessions in this folder
        </div>
      ) : (
        <div
          ref={parentRef}
          className="h-full overflow-y-auto outline-none"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onClick={() => setContextMenu(null)}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((virtualItem) => {
              const session = displaySessions[virtualItem.index];
              return (
                <div
                  key={session.agentSessionId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div
                    ref={(el) => setRef(session.agentSessionId, el)}
                    style={{ width: "100%", height: "100%" }}
                  >
                    <SessionItem
                      session={session}
                      isActive={activeSessionKey === session.agentSessionId}
                      isSelected={selectedSessionIds.has(session.agentSessionId)}
                      isEditing={onRenameSession ? editingSessionId === session.agentSessionId : false}
                      dragSessionIds={
                        selectedSessionIds.has(session.agentSessionId)
                          ? Array.from(selectedSessionIds)
                          : [session.agentSessionId]
                      }
                      onClick={(e) => {
                        if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                          setActiveSessionSummary(session);
                        }
                        toggleSessionSelection(session.agentSessionId, e.ctrlKey || e.metaKey, e.shiftKey, displaySessions);
                        if (isMobile) setActiveTab("chat");
                      }}
                      onContextMenu={(e) => handleContextMenu(session.agentSessionId, e)}
                      onEditSubmit={(name) => handleEditSubmit(session.agentSessionId, name)}
                      onEditCancel={() => setEditingSession(null)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* IntersectionObserver 센티넬: 스크롤 하단 도달 감지 */}
          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-2 text-xs text-muted-foreground">
              Loading...
            </div>
          )}
        </div>
      )}

      <SessionContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onRenameSession={onRenameSession}
        onMoveSessions={onMoveSessions}
        getSessionName={(sessionId) =>
          displaySessions.find((s) => s.agentSessionId === sessionId)?.displayName ?? ""
        }
        resolveSessionIds={(sessionId) =>
          selectedSessionIds.has(sessionId)
            ? Array.from(selectedSessionIds)
            : [sessionId]
        }
      />
    </>
  );
}
