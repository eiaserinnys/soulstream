/**
 * FolderContents - 선택된 폴더의 세션 목록
 *
 * 폴더 내 세션을 가상 스크롤로 표시. DnD/다중선택/인라인편집 지원.
 * API 호출은 콜백 props로 주입받아 앱별 엔드포인트에 의존하지 않는다.
 * 세션 행 렌더링은 SessionItem 컴포넌트에 위임한다.
 */

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useDashboardStore } from "../stores/dashboard-store";
import { useIsMobile } from "../hooks/use-mobile";
import type { SessionSummary } from "../shared/types";
import { SessionContextMenu } from "./SessionContextMenu";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { filterSessionsInFolder, type SessionPage } from "../hooks/session-stream-helpers";
import { SessionItem } from "./SessionItem";

// Re-exports for backward compatibility (FeedCard, soul-ui index 등이 참조)
export { nodeIdToHue } from "../lib/nodeColors";
export { STATUS_CONFIG } from "./SessionItem";
export type { StatusConfig } from "./SessionItem";

export interface FolderContentsProps {
  /**
   * useSessionListProvider가 반환하는 세션 배열. 폴더 필터링 + displayName 오버라이드가 적용된다.
   * 미지정 시 queryClient.getQueriesData로 전체 캐시에서 수집하는 레거시 경로를 사용한다.
   *
   * ⚠️ sessions prop 사용을 강하게 권장. 레거시 경로는 폴더 전환 시 새 queryKey의 데이터가
   * 즉시 반영되지 않아 처음 열 때 세션이 비어 보이는 버그가 있다 (SSE keepalive 후 회복).
   */
  sessions?: SessionSummary[];
  /** @deprecated DashboardDndProvider 사용 시 불필요. 레거시 직접 이동 트리거용. */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 UI 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  /** 스크롤 하단 도달 시 다음 페이지 로드 콜백 */
  onLoadMore?: () => void;
  /** 추가 로드 가능 여부 */
  hasMore?: boolean;
}

export function FolderContents({ sessions: sessionsProp, onMoveSessions, onRenameSession, onLoadMore, hasMore }: FolderContentsProps) {
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);

  // 레거시 캐시 수집 경로: queryCache.subscribe로 cacheVersion 증가 → useMemo 재계산
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => {
    if (sessionsProp) return;
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      setCacheVersion((v) => v + 1);
    });
    return unsubscribe;
  }, [queryClient, sessionsProp]);

  const displaySessions = useMemo(() => {
    if (sessionsProp) {
      return filterSessionsInFolder(sessionsProp, catalog, selectedFolderId);
    }
    const allData = queryClient.getQueriesData<InfiniteData<SessionPage>>({ queryKey: ["sessions"], exact: false });
    const allSessions: SessionSummary[] = [];
    for (const [, data] of allData) {
      if (!data) continue;
      for (const page of data.pages) allSessions.push(...page.sessions);
    }
    const uniqueSessions = Array.from(new Map(allSessions.map((s) => [s.agentSessionId, s])).values());
    return filterSessionsInFolder(uniqueSessions, catalog, selectedFolderId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsProp, cacheVersion, catalog, selectedFolderId, queryClient]);

  const prevFolderIdRef = useRef<string | null | undefined>(undefined);
  const parentRef = useRef<HTMLDivElement>(null);

  // 폴더 전환 시 스크롤 초기화 + 자동 세션 선택 (모바일 제외 — 2단계 뷰 유지)
  useEffect(() => {
    if (prevFolderIdRef.current !== undefined && prevFolderIdRef.current !== selectedFolderId) {
      parentRef.current?.scrollTo({ top: 0, behavior: "instant" });
    }
    prevFolderIdRef.current = selectedFolderId;

    if (!isMobile && displaySessions.length > 0 && !activeSessionKey) {
      setActiveSession(displaySessions[0].agentSessionId);
      setActiveSessionSummary(displaySessions[0]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 폴더 전환 시에만 실행
  }, [selectedFolderId]);

  const sentinelRef = useRef<HTMLDivElement>(null);

  // IntersectionObserver: 스크롤 하단 도달 시 다음 페이지 로드
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
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
                  <div ref={(el) => setRef(session.agentSessionId, el)} style={{ width: "100%", height: "100%" }}>
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
