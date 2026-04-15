/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링합니다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송합니다.
 *
 * Follow mode: NodeGraph 패턴과 동일한 follow/unfollow 토글.
 * Tool grouping: 연속된 tool 메시지를 접기/펼치기 그룹으로 묶어 표시.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDashboardStore } from "../../stores/dashboard-store";
import { flattenTree } from "../../lib/flatten-tree";
import { ChatInput } from "../ChatInput";
import { cn } from "../../lib/cn";
import { useLlmContext } from "./hooks";
import { groupMessages } from "./grouping";
import { VirtualizedItem } from "./VirtualizedItem";

/** 스크롤 하단 판정 threshold (px) */
const SCROLL_THRESHOLD = 50;

interface ChatViewProps {
  chatInputDisabled?: boolean;
  isOtherNodeSession?: boolean;
}

export function ChatView({ chatInputDisabled = false, isOtherNodeSession = false }: ChatViewProps = {}) {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const focusEventId = useDashboardStore((s) => s.focusEventId);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  const llmContext = useLlmContext();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => flattenTree(tree), [tree, treeVersion]);
  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // === Virtualizer ===
  const virtualizer = useVirtualizer({
    count: grouped.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  // === Follow mode ===
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const prevTreeVersion = useRef(treeVersion);
  // ref로 effect 내부에서 최신 상태를 참조 (effect deps에서 제거하여 불필요한 재실행 방지)
  const isFollowingRef = useRef(true);
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  // 프로그래밍 스크롤 중 scroll 이벤트가 follow를 해제하지 않도록 가드
  const isProgrammaticScroll = useRef(false);

  const checkScrollPosition = useCallback(() => {
    // 프로그래밍 스크롤 중에는 follow 해제하지 않음
    if (isProgrammaticScroll.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_THRESHOLD;
    if (atBottom && !isFollowingRef.current) {
      // 사용자가 직접 맨 아래로 스크롤하면 follow 재활성화
      setIsFollowing(true);
      setShowNewMessage(false);
    } else if (!atBottom && isFollowingRef.current) {
      setIsFollowing(false);
    }
  }, []);

  // 새 이벤트 시: following이면 스크롤, 아니면 "New Messages" 배너 표시
  useEffect(() => {
    if (treeVersion === prevTreeVersion.current) return;
    prevTreeVersion.current = treeVersion;

    if (isFollowingRef.current && grouped.length > 0) {
      isProgrammaticScroll.current = true;
      virtualizer.scrollToIndex(grouped.length - 1, { align: "end" });
      const scrollEl = scrollRef.current;
      if (scrollEl) {
        scrollEl.addEventListener("scrollend", () => {
          isProgrammaticScroll.current = false;
        }, { once: true });
        // fallback: scrollend가 발생하지 않는 경우 (스크롤 없이 콘텐츠 추가 등)
        setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
      }
    } else if (!isFollowingRef.current) {
      setShowNewMessage(true);
    }
  }, [treeVersion]);

  // 세션 변경 시: follow 리셋
  // isProgrammaticScroll 가드: 프로그래매틱 스크롤이 checkScrollPosition을 트리거하여
  // 방금 켠 isFollowing을 다시 끄는 경쟁 조건을 방지한다.
  useEffect(() => {
    setIsFollowing(true);
    setShowNewMessage(false);
    if (scrollRef.current) {
      isProgrammaticScroll.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    }
  }, [activeSessionKey]);

  // 검색 결과 클릭 시: focusEventId에 해당하는 메시지로 스크롤 + 2초간 하이라이트
  // 가상화 환경: grouped 배열에서 인덱스를 찾아 scrollToIndex로 이동한 후, rAF로 DOM 요소에 하이라이트 적용
  const focusAttemptsRef = useRef(0);
  useEffect(() => {
    if (!focusEventId || !scrollRef.current) return;

    // grouped 배열에서 focusEventId와 매칭되는 인덱스 찾기
    const targetIndex = grouped.findIndex((item) => {
      if (item.type === "tool-group") {
        return item.messages.some((m) => m.eventId === focusEventId || m.treeNodeId?.endsWith(`-${focusEventId}`));
      }
      return item.msg.eventId === focusEventId || item.msg.treeNodeId?.endsWith(`-${focusEventId}`);
    });

    if (targetIndex >= 0) {
      focusAttemptsRef.current = 0;
      isProgrammaticScroll.current = true;
      virtualizer.scrollToIndex(targetIndex, { align: "center" });

      // 스크롤 완료 후 DOM 요소에 하이라이트 적용
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
        const el = scrollRef.current?.querySelector(
          `[data-tree-node-id$="-${focusEventId}"]`,
        ) as HTMLElement | null;
        if (el) {
          el.classList.add("ring-2", "ring-accent-amber", "rounded");
          setTimeout(() => {
            el.classList.remove("ring-2", "ring-accent-amber", "rounded");
            setFocusEventId(null);
          }, 2000);
        } else {
          setFocusEventId(null);
        }
      });
      return;
    }

    // grouped에서 못 찾음: 세션 로딩 중일 수 있으므로 treeVersion 갱신마다 재시도.
    // 최대 20회 시도 후 포기 (text_delta/tool_result 등 DOM 노드가 없는 이벤트 대응).
    focusAttemptsRef.current += 1;
    if (focusAttemptsRef.current >= 20) {
      focusAttemptsRef.current = 0;
      setFocusEventId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEventId, treeVersion, setFocusEventId, grouped, virtualizer]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current && grouped.length > 0) {
      isProgrammaticScroll.current = true;
      virtualizer.scrollToIndex(grouped.length - 1, { align: "end", behavior: "smooth" });
      setIsFollowing(true);
      setShowNewMessage(false);
      scrollRef.current.addEventListener("scrollend", () => {
        isProgrammaticScroll.current = false;
      }, { once: true });
      // fallback: scrollend가 발생하지 않는 경우 (이미 맨 아래에 있을 때 등)
      setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
    }
  }, [grouped.length, virtualizer]);

  const toggleFollow = useCallback(() => {
    setIsFollowing((prev) => {
      const next = !prev;
      if (next && scrollRef.current && grouped.length > 0) {
        isProgrammaticScroll.current = true;
        virtualizer.scrollToIndex(grouped.length - 1, { align: "end", behavior: "smooth" });
        setShowNewMessage(false);
        scrollRef.current.addEventListener("scrollend", () => {
          isProgrammaticScroll.current = false;
        }, { once: true });
        // fallback: scrollend가 발생하지 않는 경우 (이미 맨 아래에 있을 때 등)
        setTimeout(() => { isProgrammaticScroll.current = false; }, 150);
      }
      return next;
    });
  }, [grouped.length, virtualizer]);

  if (!activeSessionKey) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a session to view chat
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={checkScrollPosition}
        className="flex-1 overflow-y-auto overflow-x-hidden py-2 overscroll-none"
      >
        {messages.length === 0 && (
          <div className="p-5 text-center text-muted-foreground text-sm">
            Waiting for events...
          </div>
        )}

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const item = grouped[vi.index];
            return (
              <VirtualizedItem
                key={vi.key}
                vi={vi}
                item={item}
                measureElement={virtualizer.measureElement}
                llmContext={llmContext}
                sessionId={activeSessionKey ?? undefined}
              />
            );
          })}
        </div>
      </div>

      {/* "New Messages" banner */}
      {showNewMessage && !isFollowing && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-[var(--panel-inset)] left-1/2 -translate-x-1/2 text-xs text-muted-foreground bg-popover/90 border border-border rounded-full px-3 py-1 hover:text-foreground hover:bg-popover transition-colors shadow-sm z-10"
          >
            {"\u2193"} New Messages
          </button>
        </div>
      )}

      {/* Follow toggle button */}
      <div className="relative">
        <button
          onClick={toggleFollow}
          className={cn(
            "absolute bottom-[15px] right-[15px] flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
            "border shadow-md z-10",
            isFollowing
              ? "bg-accent-blue/15 border-accent-blue/30 text-accent-blue hover:bg-accent-blue/25"
              : "bg-popover border-border text-muted-foreground hover:bg-input",
          )}
        >
          {"\u2193"} Follow
        </button>
      </div>

      {/* ChatInput */}
      <ChatInput additionalDisabled={chatInputDisabled} isOtherNodeSession={isOtherNodeSession} />
    </div>
  );
}
