/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링합니다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송합니다.
 *
 * Follow mode: NodeGraph 패턴과 동일한 follow/unfollow 토글.
 * Tool grouping: 연속된 tool 메시지를 접기/펼치기 그룹으로 묶어 표시.
 */

import { useMemo, useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDashboardStore } from "../../stores/dashboard-store";
import { flattenTree } from "../../lib/flatten-tree";
import { ChatInput } from "../ChatInput";
import { cn } from "../../lib/cn";
import { useLlmContext } from "./hooks";
import { groupMessages } from "./grouping";
import { VirtualizedItem } from "./VirtualizedItem";
import { useEstimateSize } from "../../hooks/useEstimateSize";
import { useMessageHistoryBuffer } from "./useMessageHistoryBuffer";
import { historicalToChatMessages } from "../../lib/history-to-chat";
import {
  shouldRunInitialBottomScroll,
  computePrependAnchorDelta,
} from "./ChatView.scroll-helpers";

/** 스크롤 하단 판정 threshold (px) */
const SCROLL_THRESHOLD = 50;

/** 스크롤 상단 판정 threshold (px) — 이 이하로 올라오면 과거 메시지 prepend 요청 */
const SCROLL_TOP_THRESHOLD = 80;

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

  // Phase 3: DB에서 가져온 과거 메시지 로컬 버퍼.
  // 라이브 SSE 기반 store.tree와 공존하며, 렌더러가 eventId로 dedup하여 병합한다.
  const history = useMessageHistoryBuffer(activeSessionKey);

  // SSE 라이브 이벤트 (tree에 쌓인 것)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const liveMessages = useMemo(() => flattenTree(tree), [tree, treeVersion]);

  // DB 히스토리 → ChatMessage 변환
  const historicalMessages = useMemo(
    () => historicalToChatMessages(history.messages),
    [history.messages],
  );

  // 히스토리 + 라이브 병합: eventId 기준 dedup, 시간순 정렬
  const messages = useMemo(() => {
    if (historicalMessages.length === 0) return liveMessages;
    if (liveMessages.length === 0) return historicalMessages;

    // 라이브 메시지의 eventId 집합 (dedup 기준)
    const liveEventIds = new Set<number>();
    for (const m of liveMessages) {
      if (m.eventId != null) liveEventIds.add(m.eventId);
    }

    // 히스토리에만 있는 메시지 + 라이브 전체
    const historyOnly = historicalMessages.filter(
      (m) => m.eventId == null || !liveEventIds.has(m.eventId),
    );
    return [...historyOnly, ...liveMessages];
  }, [historicalMessages, liveMessages]);
  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // === Follow mode ===
  const scrollRef = useRef<HTMLDivElement>(null);

  // === Virtualizer ===
  const estimateSize = useEstimateSize(scrollRef, grouped, activeSessionKey);
  const virtualizer = useVirtualizer({
    count: grouped.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 5,
  });
  const [isFollowing, setIsFollowing] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const prevTreeVersion = useRef(treeVersion);
  // ref로 effect 내부에서 최신 상태를 참조 (effect deps에서 제거하여 불필요한 재실행 방지)
  const isFollowingRef = useRef(true);
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  // 프로그래밍 스크롤 중 scroll 이벤트가 follow를 해제하지 않도록 가드
  const isProgrammaticScroll = useRef(false);

  // 세션당 최초 1회만 초기 하단 이동을 수행하기 위한 guard
  const didInitialScrollRef = useRef<string | null>(null);

  // 과거 메시지 prepend 직전 스냅샷 — prepend 반영 후 scroll anchor 복원에 사용
  const prependAnchorRef = useRef<{
    scrollHeight: number;
    messagesLength: number;
  } | null>(null);

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
    // Phase 3: 위로 스크롤 시 과거 메시지 prepend 요청.
    // 훅 내부에서 loading/reachedTop/cursor null 가드 → 중복/무의미한 호출 자동 무시.
    if (el.scrollTop <= SCROLL_TOP_THRESHOLD) {
      // 초기 하단 이동이 완료된 세션에서만 anchor 스냅샷을 찍는다.
      // 초기화 과정 중 measure 프레임에서 scrollTop이 0 근처일 수 있는데,
      // 그 시점에 snapshot이 세팅되면 이후 history 로드로 발화하는 initial-bottom
      // effect와 prepend anchor 보정이 중복 조작될 위험이 있다.
      if (didInitialScrollRef.current === activeSessionKey) {
        prependAnchorRef.current = {
          scrollHeight: el.scrollHeight,
          messagesLength: history.messages.length,
        };
      }
      history.requestOlder();
    }
  }, [history, activeSessionKey]);

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

  // 세션 변경 시: follow 리셋만 수행.
  // scrollTop 조작은 하지 않는다 — 이 시점에는 아직 히스토리가 비어 있어 scrollHeight가 0이므로
  // 여기서 scrollTop을 만져봐야 무의미하다. 실제 하단 이동은 아래의 초기 하단 이동 effect가 담당.
  useEffect(() => {
    setIsFollowing(true);
    setShowNewMessage(false);
  }, [activeSessionKey]);

  // 세션 전환 후 첫 히스토리 로드 완료 시 하단 이동 (세션당 1회).
  // shouldRunInitialBottomScroll: grouped.length>0 && !history.loading && 아직 안 한 세션일 때 true.
  // measure가 순차 진행되므로 rAF 2회로 최종 보정까지 수행.
  //  1) scrollToIndex로 estimate 기반 대략 이동
  //  2) rAF 후 scrollToIndex 재호출 → measure가 실측치로 totalSize 갱신된 상태로 정확 이동
  //  3) rAF 후 scrollTop=scrollHeight로 rounding 오차까지 확정
  useEffect(() => {
    if (
      !shouldRunInitialBottomScroll({
        sessionKey: activeSessionKey,
        groupedLength: grouped.length,
        historyLoading: history.loading,
        lastScrolledSessionKey: didInitialScrollRef.current,
      })
    ) {
      return;
    }
    didInitialScrollRef.current = activeSessionKey;

    isProgrammaticScroll.current = true;
    virtualizer.scrollToIndex(grouped.length - 1, { align: "end" });
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(grouped.length - 1, { align: "end" });
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        isProgrammaticScroll.current = false;
      });
    });
  }, [activeSessionKey, grouped.length, history.loading, virtualizer]);

  // 과거 메시지 prepend 후 scroll anchor 복원.
  // onScroll이 requestOlder 직전 snapshot을 찍어 두었다가,
  // history.messages.length 증가(= prepend 반영)를 감지한 layout 단계에서
  // (새 scrollHeight - 이전 scrollHeight)만큼 scrollTop을 밀어 시각적 위치를 유지한다.
  // useLayoutEffect로 paint 이전에 보정해야 점프가 시각적으로 나타나지 않는다.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = computePrependAnchorDelta({
      snapshot: prependAnchorRef.current,
      currentScrollHeight: el.scrollHeight,
      currentMessagesLength: history.messages.length,
    });
    if (delta != null) {
      isProgrammaticScroll.current = true;
      el.scrollTop = el.scrollTop + delta;
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false;
      });
    }
    // snapshot은 한 번 반영되면 폐기 (다음 requestOlder 때 다시 세팅된다)
    if (
      prependAnchorRef.current &&
      history.messages.length > prependAnchorRef.current.messagesLength
    ) {
      prependAnchorRef.current = null;
    }
  }, [history.messages.length]);

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

        {/* Phase 3: 과거 페이지 로딩 / 맨 위 도달 인디케이터 */}
        {history.loading && (
          <div className="p-2 text-center text-muted-foreground text-xs">
            Loading earlier messages...
          </div>
        )}
        {history.reachedTop && messages.length > 0 && (
          <div className="py-2 px-3 text-center text-muted-foreground text-xs opacity-60">
            {"\u2014"} Beginning of conversation {"\u2014"}
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
