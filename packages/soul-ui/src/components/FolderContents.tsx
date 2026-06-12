/**
 * FolderContents - 선택된 폴더의 세션 목록
 *
 * 폴더 내 세션을 가상 스크롤로 표시. DnD/다중선택/인라인편집 지원.
 * API 호출은 콜백 props로 주입받아 앱별 엔드포인트에 의존하지 않는다.
 * 세션 행 렌더링은 SessionItem 컴포넌트에 위임한다.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDashboardStore } from "../stores/dashboard-store";
import { useIsMobile } from "../hooks/use-mobile";
import type { SessionSummary } from "../shared/types";
import { SessionContextMenu } from "./SessionContextMenu";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { applyCatalogDisplayNames } from "../hooks/session-stream-helpers";
import { SessionItem } from "./SessionItem";
import { resolveFolderActiveSessionDecision } from "./folder-active-session";
import { runGuardedLoadMore, type LoadMoreCallback } from "./load-more-guard";

// Re-exports for backward compatibility (FeedCard, soul-ui index 등이 참조)
export { nodeIdToHue } from "../lib/nodeColors";
export { STATUS_CONFIG } from "./SessionItem";
export type { StatusConfig } from "./SessionItem";

const EMPTY_SESSIONS: SessionSummary[] = [];

export interface FolderContentsProps {
  /**
   * useSessionListProvider가 반환하는 세션 배열. 폴더 필터링 + displayName 오버라이드가 적용된다.
   * 미지정 시 빈 목록으로 처리한다. 전체 query cache를 훑는 레거시 fallback은 제거되었다.
   */
  sessions?: SessionSummary[];
  /** @deprecated DashboardDndProvider 사용 시 불필요. 레거시 직접 이동 트리거용. */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 UI 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  /** 원본 세션의 맥락을 이어 받을 새 세션 생성 콜백 */
  onContinueSession?: (sessionId: string) => Promise<void>;
  /** 이어 시작 메뉴 비활성 사유. null이면 실행 가능 */
  getContinueSessionDisabledReason?: (sessionId: string) => string | null;
  /** 스크롤 하단 도달 시 다음 페이지 로드 콜백 */
  onLoadMore?: LoadMoreCallback;
  /** 추가 로드 가능 여부 */
  hasMore?: boolean;
}

export function FolderContents({
  sessions: sessionsProp = EMPTY_SESSIONS,
  onMoveSessions,
  onRenameSession,
  onContinueSession,
  getContinueSessionDisabledReason,
  onLoadMore,
  hasMore,
}: FolderContentsProps) {
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const clearActiveSession = useDashboardStore((s) => s.clearActiveSession);
  const toggleSessionSelection = useDashboardStore((s) => s.toggleSessionSelection);
  const selectedSessionIds = useDashboardStore((s) => s.selectedSessionIds);
  const editingSessionId = useDashboardStore((s) => s.editingSessionId);
  const setEditingSession = useDashboardStore((s) => s.setEditingSession);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const catalog = useDashboardStore((s) => s.catalog);
  const isMobile = useIsMobile();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  const displaySessions = useMemo(() => {
    return applyCatalogDisplayNames(sessionsProp, catalog);
  }, [sessionsProp, catalog]);

  const prevFolderIdRef = useRef<string | null | undefined>(undefined);
  const parentRef = useRef<HTMLDivElement>(null);
  const keepActiveSessionWhenEmpty = useMemo(() => {
    if (!activeSessionKey || activeSessionSummary?.agentSessionId !== activeSessionKey) {
      return false;
    }
    const activeFolderId =
      catalog?.sessions?.[activeSessionKey]?.folderId
      ?? activeSessionSummary.folderId
      ?? null;
    return activeFolderId === selectedFolderId;
  }, [activeSessionKey, activeSessionSummary, catalog, selectedFolderId]);

  // 폴더 전환 시 스크롤 초기화
  useEffect(() => {
    if (prevFolderIdRef.current !== undefined && prevFolderIdRef.current !== selectedFolderId) {
      parentRef.current?.scrollTo({ top: 0, behavior: "instant" });
    }
    prevFolderIdRef.current = selectedFolderId;
  }, [selectedFolderId]);

  // 데스크톱 폴더 뷰는 오른쪽 패널이 항상 현재 폴더의 세션을 보여야 한다.
  // 목록이 비동기로 늦게 들어오는 경우도 있어 displaySessions 변경을 같이 본다.
  useEffect(() => {
    const decision = resolveFolderActiveSessionDecision({
      activeSessionKey,
      keepActiveSessionWhenEmpty,
      isMobile,
      sessions: displaySessions,
    });
    if (decision.action === "select") {
      setActiveSession(decision.session.agentSessionId);
      setActiveSessionSummary(decision.session);
    } else if (decision.action === "clear") {
      clearActiveSession();
    }
  }, [
    activeSessionKey,
    clearActiveSession,
    displaySessions,
    isMobile,
    keepActiveSessionWhenEmpty,
    setActiveSession,
    setActiveSessionSummary,
  ]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreGateRef = useRef(false);

  // IntersectionObserver: 스크롤 하단 도달 시 다음 페이지 로드
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) runGuardedLoadMore(loadMoreGateRef, onLoadMore);
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore]);

  const virtualizer = useVirtualizer({
    count: displaySessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 118,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const { getItemRef } = useFlipAnimation(displaySessions, virtualItems);

  const handleContextMenu = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handleEditSubmit = useCallback(
    async (sessionId: string, name: string) => {
      const displayName = name.trim() || null;
      setEditingSession(null);
      if (onRenameSession) await onRenameSession(sessionId, displayName);
    },
    [setEditingSession, onRenameSession],
  );

  const handleSessionClick = useCallback(
    (session: SessionSummary, e: React.MouseEvent) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) setActiveSessionSummary(session);
      toggleSessionSelection(session.agentSessionId, e.ctrlKey || e.metaKey, e.shiftKey, displaySessions);
      if (isMobile) setActiveTab("chat");
    },
    [setActiveSessionSummary, toggleSessionSelection, displaySessions, isMobile, setActiveTab],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "F2" && activeSessionKey && onRenameSession) setEditingSession(activeSessionKey);
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
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
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
                    ref={getItemRef(session.agentSessionId)}
                    className="px-2 py-1"
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
                      onClick={(e) => handleSessionClick(session, e)}
                      onContextMenu={(e) => handleContextMenu(session.agentSessionId, e)}
                      onEditSubmit={(name) => handleEditSubmit(session.agentSessionId, name)}
                      onEditCancel={() => setEditingSession(null)}
                    />
                  </div>
                </div>
              );
            })}
          </div>

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
        onContinueSession={onContinueSession}
        getContinueSessionDisabledReason={getContinueSessionDisabledReason}
        getSessionName={(sessionId) =>
          displaySessions.find((s) => s.agentSessionId === sessionId)?.displayName ?? ""
        }
        resolveSessionIds={(sessionId) =>
          selectedSessionIds.has(sessionId) ? Array.from(selectedSessionIds) : [sessionId]
        }
      />
    </>
  );
}
