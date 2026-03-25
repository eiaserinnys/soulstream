/**
 * FeedView - 피드 뷰 메인 컴포넌트
 *
 * 최근 24시간 내 변경된 세션을 카드 리스트로 표시한다.
 * @tanstack/react-virtual로 가상 스크롤을 적용한다.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDashboardStore } from "../stores/dashboard-store";
import { FeedCard } from "./FeedCard";

const CARD_HEIGHT = 220;
const CARD_GAP = 12;
const ESTIMATED_SIZE = CARD_HEIGHT + CARD_GAP;

export function FeedView() {
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const sessions = useDashboardStore((s) => s.sessions);
  const catalog = useDashboardStore((s) => s.catalog);
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

  // sessions가 변경될 때마다 getFeedSessions 재계산 (memoized)
  const feedSessions = useMemo(() => getFeedSessions(), [sessions, getFeedSessions]);
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
      // activeSessionKey가 sessions 배열에 존재하는지 확인
      const existsInSessions = sessions.some(
        (s) => s.agentSessionId === activeSessionKey,
      );
      if (!existsInSessions) {
        // 세션이 삭제됨 → 피드 첫 세션 선택
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
  }, [viewMode, activeSessionKey, firstFeedId, sessions, setActiveSession, clearActiveSession]);

  // 가상 스크롤
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: feedSessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_SIZE,
    overscan: 3,
  });

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

  // 빈 상태
  if (feedSessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        최근 24시간 이내 활동한 세션이 없습니다
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto px-4 py-3"
      onScroll={handleScroll}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
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
              <FeedCard
                session={session}
                isActive={session.agentSessionId === activeSessionKey}
                folderName={getFolderName(session.agentSessionId)}
                onClick={() => handleCardClick(session.agentSessionId)}
                onDoubleClick={() => handleCardDoubleClick(session.agentSessionId)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
