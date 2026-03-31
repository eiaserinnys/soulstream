/**
 * FeedView - 피드 뷰 메인 컴포넌트
 *
 * 최근 24시간 내 변경된 세션을 카드 리스트로 표시한다.
 * @tanstack/react-virtual로 가상 스크롤을 적용한다.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDashboardStore } from "../stores/dashboard-store";
import { FeedCard } from "./FeedCard";
import { FeedTopBar } from "./FeedTopBar";
import { SessionContextMenu } from "./SessionContextMenu";
import { useFlipAnimation } from "../hooks/useFlipAnimation";

const CARD_HEIGHT = 220;
const CARD_GAP = 12;
const ESTIMATED_SIZE = CARD_HEIGHT + CARD_GAP;

export interface FeedViewProps {
  onNewSession?: () => void;
  /** 인피니트 스크롤: 목록 끝 근처에 도달하면 호출 */
  onLoadMore?: () => void;
  /** 추가 로드 가능 여부 */
  hasMore?: boolean;
  /** 세션 이름 변경 콜백. 미지정 시 이름 변경 메뉴 비활성화 */
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  /** 세션 폴더 이동 콜백. 미지정 시 폴더 이동 메뉴 비활성화 */
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
}

export function FeedView({ onNewSession, onLoadMore, hasMore, onRenameSession, onMoveSessions }: FeedViewProps = {}) {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const sessions = useDashboardStore((s) => s.sessions);
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const getFeedSessions = useDashboardStore((s) => s.getFeedSessions);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const clearActiveSession = useDashboardStore((s) => s.clearActiveSession);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const feedScrollOffset = useDashboardStore((s) => s.feedScrollOffset);
  const setFeedScrollOffset = useDashboardStore((s) => s.setFeedScrollOffset);

  // 1분 주기 갱신 (24시간 윈도우 밖으로 밀린 세션 제거용)
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  // sessions 또는 catalog가 변경될 때마다 getFeedSessions 재계산 (memoized)
  // catalogVersion을 deps에 포함하여 세션 이름 변경 시 피드 카드 즉시 반영
  const feedSessions = useMemo(() => getFeedSessions(), [sessions, getFeedSessions, catalogVersion]);
  const firstFeedId = feedSessions[0]?.agentSessionId ?? null;

  // 폴더명 조회 헬퍼
  const getFolderName = useCallback(
    (sessionId: string): string | undefined => {
      if (!catalog?.sessions || !catalog.folders) return undefined;
      const assignment = catalog.sessions[sessionId];
      if (!assignment?.folderId) return undefined;
      return catalog.folders.find((f) => f.id === assignment.folderId)?.name;
    },
    [catalog],
  );

  // 자동 선택: 피드 뷰에서 activeSessionKey가 없으면 최신 세션 선택
  useEffect(() => {
    if (viewMode !== "feed") return;
    if (activeSessionKey) {
      // activeSessionKey가 피드 세션 목록에 존재하는지 확인.
      // 주기적 리프레시로 sessions 배열이 교체되어도 피드에 여전히 보이는 세션은 선택을 유지한다.
      // (sessions 전체가 아닌 feedSessions 기준으로 체크해야 리프레시 시 선택이 초기화되지 않는다)
      const existsInFeed = feedSessions.some(
        (s) => s.agentSessionId === activeSessionKey,
      );
      if (!existsInFeed) {
        // 세션이 피드에서 사라짐 (삭제되었거나 24시간 윈도우 밖으로 밀림) → 피드 첫 세션 선택
        if (firstFeedId) {
          setActiveSession(firstFeedId);
        } else {
          clearActiveSession();
        }
      }
      return;
    }
    // activeSessionKey가 null → 최신 세션 자동 선택
    if (firstFeedId) {
      setActiveSession(firstFeedId);
    }
  }, [viewMode, activeSessionKey, firstFeedId, feedSessions, setActiveSession, clearActiveSession]);

  // 가상 스크롤
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: feedSessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_SIZE,
    overscan: 3,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const { setRef } = useFlipAnimation(feedSessions, virtualItems);

  // 인피니트 스크롤: virtualizer가 목록 끝 근처에 도달하면 onLoadMore 호출
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const isLoadingMore = useRef(false);

  useEffect(() => {
    if (!hasMore || !onLoadMore) return;
    if (virtualItems.length === 0) return;
    const lastVirtual = virtualItems[virtualItems.length - 1];
    // 마지막 virtualItem이 전체 아이템 수의 마지막 3개 이내에 들어오면 로드
    if (lastVirtual.index >= feedSessions.length - 3 && !isLoadingMore.current) {
      isLoadingMore.current = true;
      Promise.resolve(loadMoreRef.current?.()).finally(() => {
        isLoadingMore.current = false;
      });
    }
  }, [virtualItems, feedSessions.length, hasMore, onLoadMore]);

  // 스크롤 위치 복원 (마운트 시)
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !parentRef.current) return;
    if (feedScrollOffset > 0) {
      parentRef.current.scrollTop = feedScrollOffset;
    }
    restored.current = true;
  }, [feedScrollOffset]);

  // 스크롤 위치 저장 (RAF throttle)
  const rafId = useRef(0);
  const handleScroll = useCallback(() => {
    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(() => {
      if (parentRef.current) {
        setFeedScrollOffset(parentRef.current.scrollTop);
      }
    });
  }, [setFeedScrollOffset]);

  // 카드 클릭
  const handleCardClick = useCallback(
    (sessionId: string) => {
      setActiveSession(sessionId);
    },
    [setActiveSession],
  );

  // 카드 더블클릭 → 폴더 뷰로 전환
  const handleCardDoubleClick = useCallback(
    (sessionId: string) => {
      if (!catalog?.sessions) return;
      const assignment = catalog.sessions[sessionId];
      const folderId = assignment?.folderId ?? null;
      selectFolder(folderId);
      // selectFolder가 viewMode: "folder"도 함께 설정
    },
    [catalog, selectFolder],
  );

  // 컨텍스트 메뉴
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  const handleContextMenu = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
    },
    [],
  );

  const getSessionName = useCallback(
    (sessionId: string) =>
      feedSessions.find((s) => s.agentSessionId === sessionId)?.displayName ?? "",
    [feedSessions],
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <FeedTopBar onNewSession={onNewSession} />
      {feedSessions.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-muted-foreground text-sm">
          최근 24시간 이내 활동한 세션이 없습니다
        </div>
      ) : (
        <div
          ref={parentRef}
          className="flex-1 overflow-y-auto px-4 py-3"
          onScroll={handleScroll}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((virtualItem) => {
              const session = feedSessions[virtualItem.index];
              if (!session) return null;
              return (
                <div
                  key={session.agentSessionId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: CARD_HEIGHT,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div
                    ref={(el) => setRef(session.agentSessionId, el)}
                    style={{ width: "100%", height: "100%" }}
                  >
                    <FeedCard
                      session={session}
                      isActive={session.agentSessionId === activeSessionKey}
                      folderName={getFolderName(session.agentSessionId)}
                      onClick={() => handleCardClick(session.agentSessionId)}
                      onDoubleClick={() => handleCardDoubleClick(session.agentSessionId)}
                      onContextMenu={(e) => handleContextMenu(session.agentSessionId, e)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <SessionContextMenu
        contextMenu={contextMenu}
        onClose={() => setContextMenu(null)}
        onRenameSession={onRenameSession}
        onMoveSessions={onMoveSessions}
        getSessionName={getSessionName}
        resolveSessionIds={(sessionId) => [sessionId]}
      />
    </div>
  );
}
