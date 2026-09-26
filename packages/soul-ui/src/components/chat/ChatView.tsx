/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링한다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송한다.
 *
 * Phase 4 재설계:
 * - react-virtuoso + `alignToBottom + followOutput="auto"` 로 "첫 paint가 이미 최하단" 을 달성.
 *   이동 궤적 없이 하단 고정.
 * - prepend는 virtuoso 공식 패턴 `firstItemIndex -= N` (store.chatPrependedCount 참조 — 정본은 store).
 * - 과거 로드는 startReached/viewport geometry/수동 재시도가 하나의 bounded controller를 사용.
 * - focusEventId 하이라이트는 `itemsRendered` 콜백에서 Virtuoso 행 key로 찾는다.
 * - 세션 전환은 Virtuoso `key={activeSessionKey}` 재마운트로 처리.
 *
 * Follow mode: 새 메시지 도착 시 자동 스크롤 follow/unfollow 토글.
 * Tool grouping: 연속된 tool 메시지를 접기/펼치기 그룹으로 묶어 표시.
 */

import { useMemo, useRef, useEffect, useState, useCallback, useLayoutEffect, type CSSProperties } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useDashboardStore } from "../../stores/dashboard-store";
import { flattenTree } from "../../lib/flatten-tree";
import { ChatInput } from "../ChatInput";
import { cn } from "../../lib/cn";
import { useLlmContext } from "./hooks";
import { groupMessages } from "../../lib/grouping";
import { VirtualizedItem } from "./VirtualizedItem";
import { useMessageHistoryBuffer } from "./useMessageHistoryBuffer";
import {
  areMessageGroupsRenderEqual,
  findFocusIndex,
  getBottomScrollLocation,
  getInitialTopMostItemIndex,
  messageOrGroupKey,
} from "./ChatView.reverse-helpers";
import { useChatLogicalInsertionCoordinate } from "./useChatLogicalInsertionCoordinate";
import { useChatViewportRetention } from "./useChatViewportRetention";
import {
  resolveFollowOutput,
  shouldScrollToBottomOnTreeChange,
} from "./ChatView.follow-helpers";
import { ChatRuntimeCompactStrips } from "./ChatRuntimeCompactStrips";
import { ProfileAvatar } from "../ProfileAvatar";
import { CHAT_STATUS_TONE_CONFIG } from "./chat-tone-config";
import { useGlassSurface } from "../LiquidGlassProvider";
import { resolveChatTypography } from "../../lib/chat-typography";
import { SessionModelPresetBadge } from "../SessionModelPresetBadge";
import { SessionStoryDisclosure } from "../SessionStoryDisclosure";
import { buildChatTimelineItems } from "./ChatView.thinking-indicator";
import { ChatHistoryStatus } from "./ChatHistoryStatus";

interface ChatViewProps {
  chatInputDisabled?: boolean;
  isOtherNodeSession?: boolean;
  fileUploadUrl?: string;
  showHeader?: boolean;
  historyEnabled?: boolean;
}

function canNestedScrollerConsumeVerticalInput(
  target: EventTarget | null,
  outerScroller: HTMLElement | null,
  deltaY: number,
): boolean {
  if (!(target instanceof Element) || outerScroller === null || deltaY === 0) {
    return false;
  }
  let candidate: HTMLElement | null = target instanceof HTMLElement
    ? target
    : target.parentElement;
  while (candidate !== null && candidate !== outerScroller) {
    if (candidate.scrollHeight > candidate.clientHeight) {
      const overflowY = window.getComputedStyle(candidate).overflowY;
      const acceptsUserScroll = overflowY === "auto"
        || overflowY === "scroll"
        || overflowY === "overlay";
      if (acceptsUserScroll) {
        if (deltaY < 0 && candidate.scrollTop > 0.5) return true;
        if (
          deltaY > 0
          && candidate.scrollTop + candidate.clientHeight < candidate.scrollHeight - 0.5
        ) return true;
      }
    }
    candidate = candidate.parentElement;
  }
  return false;
}

export function ChatView({
  chatInputDisabled = false,
  isOtherNodeSession = false,
  fileUploadUrl,
  showHeader = true,
  historyEnabled = true,
}: ChatViewProps = {}) {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const focusEventId = useDashboardStore((s) => (
    s.focusEventSessionId === null || s.focusEventSessionId === s.activeSessionKey
      ? s.focusEventId
      : null
  ));
  const focusEventRequestId = useDashboardStore((s) => s.focusEventRequestId);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  /**
   * 채팅창 좌표 정본 — store에서 직접 select.
   *
   * processHistoryEvents가 grouped 차분만큼 atomic 갱신한다.
   * 같은 set() 안에서 tree와 함께 갱신되므로 1렌더 사이클 정합이 보장된다.
   */
  const chatPrependedCount = useDashboardStore((s) => s.chatPrependedCount);
  const chatFontSize = useDashboardStore((s) => s.chatFontSize);
  const chatTypography = resolveChatTypography(chatFontSize);
  const chatTypographyStyle = {
    "--chat-font-size": `${chatTypography.fontSize}px`,
    "--chat-line-height": `${chatTypography.lineHeight}px`,
  } as CSSProperties;
  const llmContext = useLlmContext();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => flattenTree(tree), [tree, treeVersion]);
  const grouped = useMemo(() => groupMessages(messages), [messages]);
  const chatStatus = activeSessionSummary?.status ?? "unknown";
  const timelineItems = useMemo(
    () => buildChatTimelineItems(grouped, messages, chatStatus),
    [grouped, messages, chatStatus],
  );
  const { firstItemIndex, recordFirstVisibleKey } =
    useChatLogicalInsertionCoordinate(
      timelineItems,
      activeSessionKey,
      chatPrependedCount,
    );
  const bottomScrollLocation = useMemo(
    () => getBottomScrollLocation(timelineItems.length),
    [timelineItems.length],
  );
  const initialTopMostItemIndex = useMemo(
    () => getInitialTopMostItemIndex(timelineItems.length),
    [timelineItems.length],
  );

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const headerWebglActive = useGlassSurface(headerRef, { enabled: showHeader });
  const [isFollowing, setIsFollowing] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const prevTreeVersion = useRef(treeVersion);
  const prevVisibleItemsRef = useRef(timelineItems);
  // ref로 effect 내부에서 최신 상태를 참조 (effect deps에서 제거하여 불필요한 재실행 방지)
  const isFollowingRef = useRef(true);
  const handledFocusRef = useRef<number | null>(null);
  const focusedScrollRequestRef = useRef<number | null>(null);
  const focusRingOwnersRef = useRef(new WeakMap<HTMLElement, number>());
  const focusScrollRetryRef = useRef<{
    key: string | null;
    attempts: number;
    frame: number | null;
  }>({ key: null, attempts: 0, frame: null });
  const bottomFocusedSessionRef = useRef<string | null>(null);
  const initialBottomFocusPendingSessionRef = useRef<string | null>(
    activeSessionKey,
  );
  const prevSessionKeyForFollowRef = useRef<string | null>(activeSessionKey);
  const olderHistoryIntentSessionRef = useRef<string | null>(null);
  const pointerScrollStartRef = useRef<{
    sessionKey: string;
    scrollTop: number;
  } | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const requestOlderRef = useRef<(source?: "automatic" | "manual") => void>(
    () => undefined,
  );
  if (prevSessionKeyForFollowRef.current !== activeSessionKey) {
    prevSessionKeyForFollowRef.current = activeSessionKey;
    bottomFocusedSessionRef.current = null;
    initialBottomFocusPendingSessionRef.current = activeSessionKey;
    olderHistoryIntentSessionRef.current = null;
    pointerScrollStartRef.current = null;
    touchStartYRef.current = null;
    isFollowingRef.current = true;
  }
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  const clearOlderHistoryIntent = useCallback(() => {
    olderHistoryIntentSessionRef.current = null;
  }, []);
  const consumeOlderHistoryIntent = useCallback((scroller: HTMLElement | null) => {
    if (
      activeSessionKey === null
      || olderHistoryIntentSessionRef.current !== activeSessionKey
      || (scroller !== null && scroller.scrollTop > 48)
    ) return;
    olderHistoryIntentSessionRef.current = null;
    requestOlderRef.current("automatic");
  }, [activeSessionKey]);
  const handleUserViewportInput = useCallback((event: Event) => {
    if (activeSessionKey === null) return;
    const scroller = event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : null;
    const markOlderExploration = () => {
      olderHistoryIntentSessionRef.current = activeSessionKey;
      initialBottomFocusPendingSessionRef.current = null;
      bottomFocusedSessionRef.current = activeSessionKey;
      isFollowingRef.current = false;
      setIsFollowing(false);
      consumeOlderHistoryIntent(scroller);
    };

    if (event.type === "pointerdown") {
      if (scroller === null || event.target !== scroller) {
        pointerScrollStartRef.current = null;
        return;
      }
      clearOlderHistoryIntent();
      pointerScrollStartRef.current = {
        sessionKey: activeSessionKey,
        scrollTop: scroller.scrollTop,
      };
      return;
    }
    if (event.type === "pointerup" || event.type === "pointercancel") {
      pointerScrollStartRef.current = null;
      return;
    }
    if (event.type === "scroll") {
      const pointerStart = pointerScrollStartRef.current;
      if (
        scroller !== null
        && pointerStart?.sessionKey === activeSessionKey
        && scroller.scrollTop < pointerStart.scrollTop - 0.5
      ) {
        pointerScrollStartRef.current = null;
        markOlderExploration();
      }
      return;
    }
    if (event.type === "touchstart") {
      touchStartYRef.current = (event as TouchEvent).touches[0]?.clientY ?? null;
      return;
    }
    if (event.type === "touchend" || event.type === "touchcancel") {
      touchStartYRef.current = null;
      return;
    }
    if (event.type === "touchmove") {
      const currentY = (event as TouchEvent).touches[0]?.clientY;
      const startY = touchStartYRef.current;
      if (currentY !== undefined && startY !== null && currentY > startY + 2) {
        if (canNestedScrollerConsumeVerticalInput(event.target, scroller, -1)) return;
        markOlderExploration();
      } else if (currentY !== undefined && startY !== null && currentY < startY - 2) {
        if (canNestedScrollerConsumeVerticalInput(event.target, scroller, 1)) return;
        clearOlderHistoryIntent();
      }
      return;
    }
    if (event.type === "wheel") {
      const deltaY = (event as WheelEvent).deltaY;
      if (canNestedScrollerConsumeVerticalInput(event.target, scroller, deltaY)) return;
      if (deltaY < 0) markOlderExploration();
      else if (deltaY > 0) clearOlderHistoryIntent();
      return;
    }
    if (event.type === "keydown") {
      const target = event.target instanceof Element ? event.target : null;
      if (
        target !== null
        && target !== scroller
        && target.closest(
          'a,button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]',
        ) !== null
      ) return;
      const key = (event as KeyboardEvent).key;
      if (["ArrowUp", "PageUp", "Home"].includes(key)) {
        if (canNestedScrollerConsumeVerticalInput(event.target, scroller, -1)) return;
        markOlderExploration();
      } else if (["ArrowDown", "PageDown", "End"].includes(key)) {
        if (canNestedScrollerConsumeVerticalInput(event.target, scroller, 1)) return;
        clearOlderHistoryIntent();
      }
    }
  }, [activeSessionKey, clearOlderHistoryIntent, consumeOlderHistoryIntent]);
  const {
    scrollerRef,
    bindScrollerElement,
    scheduleVisuallyFirstItem,
    cancelPendingRetention,
  } = useChatViewportRetention({
    activeSessionKey,
    grouped: timelineItems,
    firstItemIndex,
    isFollowing,
    isExplicitEventFocus: focusEventId !== null,
    recordFirstVisibleKey,
    onUserViewportInput: handleUserViewportInput,
  });
  const retryFocusScroll = useCallback(() => {
    if (activeSessionKey === null || focusEventId === null) return;
    const requestKey = `${activeSessionKey}:${focusEventId}:${focusEventRequestId}`;
    const retry = focusScrollRetryRef.current;
    if (retry.key !== requestKey) {
      retry.key = requestKey;
      retry.attempts = 0;
    }
    if (retry.frame !== null) return;
    if (retry.attempts >= 3) {
      const state = useDashboardStore.getState();
      if (
        state.activeSessionKey === activeSessionKey
        && state.focusEventId === focusEventId
        && state.focusEventSessionId === activeSessionKey
        && state.focusEventRequestId === focusEventRequestId
      ) {
        setFocusEventId(null);
      }
      return;
    }
    retry.attempts += 1;
    retry.frame = window.requestAnimationFrame(() => {
      retry.frame = null;
      const state = useDashboardStore.getState();
      if (
        state.activeSessionKey !== activeSessionKey
        || state.focusEventId !== focusEventId
        || state.focusEventSessionId !== activeSessionKey
        || state.focusEventRequestId !== focusEventRequestId
      ) return;
      const targetIndex = findFocusIndex(timelineItems, focusEventId);
      if (targetIndex < 0) return;
      cancelPendingRetention();
      virtuosoRef.current?.scrollToIndex({
        // scrollToIndex addresses the current data array. firstItemIndex only
        // shifts the stable keys used when prepending older history.
        index: targetIndex,
        align: "center",
      });
    });
  }, [
    activeSessionKey,
    cancelPendingRetention,
    focusEventId,
    focusEventRequestId,
    setFocusEventId,
    timelineItems,
  ]);
  useEffect(() => () => {
    const frame = focusScrollRetryRef.current.frame;
    if (frame !== null) window.cancelAnimationFrame(frame);
    focusScrollRetryRef.current = { key: null, attempts: 0, frame: null };
  }, [activeSessionKey, focusEventId]);
  const history = useMessageHistoryBuffer(activeSessionKey, scrollerRef, historyEnabled);
  requestOlderRef.current = history.requestOlder;
  useEffect(() => {
    if (activeSessionKey === null || focusEventId === null) return;
    if (findFocusIndex(timelineItems, focusEventId) >= 0) return;
    if (
      history.reachedTop
      || history.loading
      || !history.canLoadOlder
      || history.blockedReason === "error"
    ) return;
    // Search navigation is explicit intent to inspect an older event. Fetch one
    // page at a time until it appears; an error still requires the existing retry.
    history.requestOlder("manual");
  }, [
    activeSessionKey,
    focusEventId,
    history.blockedReason,
    history.canLoadOlder,
    history.loading,
    history.reachedTop,
    history.requestOlder,
    timelineItems,
  ]);
  const requestOlderManually = useCallback(() => {
    clearOlderHistoryIntent();
    initialBottomFocusPendingSessionRef.current = null;
    bottomFocusedSessionRef.current = activeSessionKey;
    isFollowingRef.current = false;
    setIsFollowing(false);
    history.requestOlder("manual");
  }, [activeSessionKey, clearOlderHistoryIntent, history.requestOlder]);
  const notifyHistoryViewportGeometry = history.notifyViewportGeometry;
  const bindChatScroller = useCallback((ref: HTMLElement | Window | null) => {
    if (!(ref instanceof HTMLElement)) {
      olderHistoryIntentSessionRef.current = null;
      pointerScrollStartRef.current = null;
      touchStartYRef.current = null;
    }
    bindScrollerElement(ref);
    // Descendant callback refs attach before this component's layout effects.
    // The microtask runs after the whole commit so the hook can publish its ready
    // generation first; the hook gate remains authoritative for stale callbacks.
    queueMicrotask(notifyHistoryViewportGeometry);
  }, [bindScrollerElement, notifyHistoryViewportGeometry]);
  useLayoutEffect(() => {
    notifyHistoryViewportGeometry();
  }, [history.loading, historyEnabled, notifyHistoryViewportGeometry, timelineItems]);
  const resolveVirtuosoFollowOutput = useCallback(
    () => resolveFollowOutput(isFollowingRef.current),
    [],
  );
  const scrollToBottomWithBehavior = useCallback(
    (behavior: "auto" | "smooth") => {
      if (bottomScrollLocation === null) return;
      const scroller = scrollerRef.current;
      if (scroller !== null && typeof scroller.scrollTo === "function") {
        // Virtuoso estimates unmeasured variable-height rows for scrollToIndex;
        // on a long first page that estimate can settle in the middle. Native
        // scrollHeight is the measured list boundary, and subsequent height
        // changes re-enter through totalListHeightChanged until it is exact.
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
        return;
      }
      virtuosoRef.current?.scrollToIndex({
        ...bottomScrollLocation,
        behavior,
      });
    },
    [bottomScrollLocation, scrollerRef],
  );
  const maintainBottomIfFollowing = useCallback(() => {
    if (!isFollowingRef.current) return;
    const scroller = scrollerRef.current;
    if (
      scroller !== null
      && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1
    ) return;
    scrollToBottomWithBehavior("auto");
  }, [scrollToBottomWithBehavior, scrollerRef]);
  const handleTotalListHeightChanged = useCallback(() => {
    notifyHistoryViewportGeometry();
    // 행의 실제 높이는 Markdown/접힌 도구 렌더 뒤에도 바뀔 수 있다. Follow는
    // 명시적 사용자 의도이므로 켜져 있는 동안에는 그 높이 변화도 하단에 고정한다.
    maintainBottomIfFollowing();
  }, [maintainBottomIfFollowing, notifyHistoryViewportGeometry]);

  useLayoutEffect(() => {
    if (!activeSessionKey) {
      bottomFocusedSessionRef.current = null;
      initialBottomFocusPendingSessionRef.current = null;
      return;
    }
    if (bottomScrollLocation === null) return;
    if (bottomFocusedSessionRef.current === activeSessionKey) return;
    initialBottomFocusPendingSessionRef.current = activeSessionKey;
    scrollToBottomWithBehavior("auto");
  }, [activeSessionKey, bottomScrollLocation, scrollToBottomWithBehavior]);

  // 새 이벤트 시: following이 아니면 "New Messages" 배너 표시.
  // following 중이거나 초기 bottom focus가 아직 완료되지 않았다면 하단을 유지한다.
  useEffect(() => {
    if (treeVersion === prevTreeVersion.current) return;
    prevTreeVersion.current = treeVersion;
    const visibleItemsChanged = !areMessageGroupsRenderEqual(
      prevVisibleItemsRef.current,
      timelineItems,
    );
    prevVisibleItemsRef.current = timelineItems;
    // 미로딩 anchor summary와 duplicate/reload는 treeVersion만 바꿀 수 있다.
    // 실제 렌더 행의 reference가 그대로면 follow 좌표와 banner를 건드리지 않는다.
    // 반대로 text_delta는 key와 행 수가 같아도 reference가 바뀌므로 follow를 유지한다.
    if (!visibleItemsChanged) return;
    const isInitialBottomFocusPending =
      activeSessionKey !== null &&
      initialBottomFocusPendingSessionRef.current === activeSessionKey &&
      bottomFocusedSessionRef.current !== activeSessionKey;
    if (isInitialBottomFocusPending) return;
    if (
      bottomScrollLocation !== null &&
      shouldScrollToBottomOnTreeChange(isFollowingRef.current, timelineItems.length)
    ) {
      requestAnimationFrame(() => {
        if (isFollowingRef.current) {
          scrollToBottomWithBehavior("auto");
        }
      });
      return;
    }
    if (!isFollowingRef.current && timelineItems.length > 0) {
      setShowNewMessage(true);
    }
  }, [
    treeVersion,
    timelineItems,
    bottomScrollLocation,
    activeSessionKey,
    scrollToBottomWithBehavior,
  ]);

  // 세션 변경 시: follow 상태와 이미 처리한 포커스 요청을 초기화한다.
  // focusEventId는 store 세션 전환에서 함께 초기화되며, 새 세션의 검색 포커스는
  // sessionId로 연결되어 이 effect가 같은 commit의 새 요청을 지우지 않는다.
  // 실제 스크롤 위치 리셋은 Virtuoso `key={activeSessionKey}` 재마운트로 처리된다.
  useEffect(() => {
    isFollowingRef.current = true;
    setIsFollowing(true);
    setShowNewMessage(false);
    handledFocusRef.current = null;
  }, [activeSessionKey]);

  // 검색 결과 클릭 시: focusEventId에 해당하는 메시지로 스크롤.
  // 같은 요청은 한 번만 스크롤하고, 행 highlight는 itemsRendered에서 적용한다.
  useEffect(() => {
    if (!focusEventId || timelineItems.length === 0) return;
    if (focusedScrollRequestRef.current === focusEventRequestId) return;
    const targetIndex = findFocusIndex(timelineItems, focusEventId);
    if (targetIndex < 0) return; // 다음 treeVersion tick에서 재시도
    focusedScrollRequestRef.current = focusEventRequestId;
    // 검색 결과 이동은 사용자의 명시적 과거 탐색이다. history pagination 의도를
    // 만들지는 않지만, follow/초기 bottom 보정과는 경쟁하지 않게 먼저 해제한다.
    cancelPendingRetention();
    clearOlderHistoryIntent();
    initialBottomFocusPendingSessionRef.current = null;
    bottomFocusedSessionRef.current = activeSessionKey;
    isFollowingRef.current = false;
    setIsFollowing(false);
    virtuosoRef.current?.scrollToIndex({
      index: targetIndex,
      align: "center",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelPendingRetention, focusEventId, focusEventRequestId, treeVersion, timelineItems]);

  const scrollToBottom = useCallback(() => {
    clearOlderHistoryIntent();
    isFollowingRef.current = true;
    scrollToBottomWithBehavior("smooth");
    setIsFollowing(true);
    setShowNewMessage(false);
  }, [clearOlderHistoryIntent, scrollToBottomWithBehavior]);

  const toggleFollow = useCallback(() => {
    setIsFollowing((prev) => {
      const next = !prev;
      isFollowingRef.current = next;
      if (next && bottomScrollLocation !== null) {
        clearOlderHistoryIntent();
        scrollToBottomWithBehavior("smooth");
        setShowNewMessage(false);
      }
      return next;
    });
  }, [bottomScrollLocation, clearOlderHistoryIntent, scrollToBottomWithBehavior]);

  const VirtuosoHeader = useCallback(
    () => (
      <ChatHistoryStatus
        loading={history.loading}
        reachedTop={history.reachedTop}
        canLoadOlder={history.canLoadOlder}
        blockedReason={history.blockedReason}
        onRetry={requestOlderManually}
        showReachedTop={timelineItems.length > 0}
      />
    ),
    [
      history.blockedReason,
      history.canLoadOlder,
      history.loading,
      history.reachedTop,
      requestOlderManually,
      timelineItems.length,
    ],
  );
  const virtuosoComponents = useMemo(
    () => ({ Header: VirtuosoHeader }),
    [VirtuosoHeader],
  );

  if (!activeSessionKey) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a session to view chat
      </div>
    );
  }

  const chatTitle =
    activeSessionSummary?.displayName ||
    activeSessionSummary?.lastMessage?.preview ||
    activeSessionSummary?.prompt ||
    activeSessionKey;
  const chatStatusConfig = CHAT_STATUS_TONE_CONFIG[chatStatus] ?? CHAT_STATUS_TONE_CONFIG.unknown;

  return (
    <div
      data-slot="chat-root"
      data-chat-font-size={chatFontSize}
      data-chat-first-item-index={firstItemIndex}
      style={chatTypographyStyle}
      className="flex h-full min-h-0 flex-col overflow-hidden px-3 pb-3 pt-3"
    >
      {showHeader && (
        <div
          ref={headerRef}
          className="relative z-[1] mb-3 flex h-[50px] shrink-0 items-center gap-2.5 rounded-full border border-glass-border glass-strong glass-shadow-xs px-4"
          data-liquid-glass-webgl={headerWebglActive ? "true" : undefined}
        >
          <ProfileAvatar
            role="assistant"
            hasPortrait={!!activeSessionSummary?.agentPortraitUrl}
            fallbackEmoji="🤖"
            portraitUrl={activeSessionSummary?.agentPortraitUrl}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">
              {chatTitle}
            </div>
            <div className={cn("mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden text-xs font-semibold", chatStatusConfig.chipClass)}>
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  chatStatusConfig.dotClass,
                  chatStatusConfig.animate && "animate-[lg-pulse_1.6s_infinite]",
                )}
              />
              <span className="shrink-0">{chatStatusConfig.label}</span>
              <SessionModelPresetBadge className="ml-1" session={activeSessionSummary} />
            </div>
          </div>
          <SessionStoryDisclosure sessionId={activeSessionKey} />
        </div>
      )}
      {focusEventId !== null
        && history.reachedTop
        && !history.loading
        && findFocusIndex(timelineItems, focusEventId) < 0 && (
          <div role="alert" className="shrink-0 px-3 pb-2 text-center text-sm text-accent-red">
            검색 결과 이벤트를 대화에서 찾을 수 없습니다.
          </div>
        )}
      {timelineItems.length === 0 && (
        <>
          <ChatHistoryStatus
            loading={history.loading}
            reachedTop={history.reachedTop}
            canLoadOlder={history.canLoadOlder}
            blockedReason={history.blockedReason}
            onRetry={requestOlderManually}
            showReachedTop={false}
          />
          {!history.loading && history.blockedReason === null && (
            <div className="p-5 text-center text-muted-foreground text-sm">
              Waiting for events...
            </div>
          )}
        </>
      )}
      {timelineItems.length > 0 && (
        <Virtuoso
        key={activeSessionKey}
        ref={virtuosoRef}
        scrollerRef={bindChatScroller}
        data={timelineItems}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={initialTopMostItemIndex}
        alignToBottom
        atBottomThreshold={48}
        increaseViewportBy={{ top: 800, bottom: 400 }}
        components={virtuosoComponents}
        // Follow 버튼 상태가 사용자 의도 정본이다. scalar "auto"는 Virtuoso 내부
        // at-bottom 판정이 false로 흔들리면 버튼이 켜져 있어도 따라가지 않으므로,
        // callback 형태로 명시적 follow 의도를 반환한다.
        followOutput={resolveVirtuosoFollowOutput}
        atBottomStateChange={(atBottom) => {
          const isInitialBottomFocusPending =
            activeSessionKey !== null &&
            initialBottomFocusPendingSessionRef.current === activeSessionKey &&
            bottomFocusedSessionRef.current !== activeSessionKey;
          if (isInitialBottomFocusPending && atBottom) {
            initialBottomFocusPendingSessionRef.current = null;
            bottomFocusedSessionRef.current = activeSessionKey;
            setIsFollowing(true);
            setShowNewMessage(false);
            return;
          }
          // Follow의 off 전환은 wheel/touch/keyboard/scrollbar의 실제 위쪽 입력만
          // 담당한다. 동적 행 측정에서 나오는 atBottom=false는 사용자 의도가 아니다.
          if (!atBottom) {
            maintainBottomIfFollowing();
            return;
          }
          setShowNewMessage(false);
        }}
        startReached={() => {
          consumeOlderHistoryIntent(null);
        }}
        totalListHeightChanged={handleTotalListHeightChanged}
        /**
         * tool-group은 마지막 tool, summary-group은 anchor의 키를 유지한다.
         * turn summary가 늦게 결합되어도 가상 행의 key와 data 길이가 바뀌지 않는다.
         */
        computeItemKey={(_index, item) => messageOrGroupKey(item)}
        itemContent={(_, item) => (
          <div
            data-chat-item-key={messageOrGroupKey(item)}
            className="contents"
          >
            <VirtualizedItem
              item={item}
              llmContext={llmContext}
              sessionId={activeSessionKey ?? undefined}
            />
          </div>
        )}
        itemsRendered={() => {
          // Virtuoso가 data와 spacer DOM을 같은 프레임에 정합한 뒤 geometry를 읽는다.
          // 즉시 읽으면 재배치 중인 overscan 행 또는 빈 중간 프레임을 관찰할 수 있다.
          scheduleVisuallyFirstItem();
          notifyHistoryViewportGeometry();
          // Virtuoso가 추정 높이 보정으로 초기 native bottom 이동을 되돌린 경우도
          // 다음 실제 render range에서 재확인한다. 사용자 위쪽 입력은 ref를 먼저
          // 끄므로 과거 탐색 중인 viewport와 경쟁하지 않는다.
          maintainBottomIfFollowing();
          if (focusEventId == null) return;
          // 새 요청은 같은 이벤트 ID를 다시 선택해도 처리한다.
          if (handledFocusRef.current === focusEventRequestId) return;
          const targetIndex = findFocusIndex(timelineItems, focusEventId);
          if (targetIndex < 0) return;
          const targetKey = messageOrGroupKey(timelineItems[targetIndex]);
          const targetRow = Array.from(
            scrollerRef.current?.querySelectorAll<HTMLElement>("[data-chat-item-key]") ?? [],
          ).find((row) => row.dataset.chatItemKey === targetKey);
          const el = targetRow?.querySelector<HTMLElement>("[data-tree-node-id]") ?? null;
          if (!el) {
            retryFocusScroll();
            return;
          }
          handledFocusRef.current = focusEventRequestId;
          const requestId = focusEventRequestId;
          focusRingOwnersRef.current.set(el, requestId);
          el.classList.add("chat-focus-ring");
          window.setTimeout(() => {
            if (focusRingOwnersRef.current.get(el) === requestId) {
              el.classList.remove("chat-focus-ring");
              focusRingOwnersRef.current.delete(el);
            }
            const currentFocus = useDashboardStore.getState();
            if (
              currentFocus.focusEventId === focusEventId
              && currentFocus.focusEventSessionId === activeSessionKey
              && currentFocus.focusEventRequestId === requestId
            ) {
              setFocusEventId(null);
            }
          }, 2000);
        }}
          className="flex-1 min-h-0 overflow-x-hidden py-2 overscroll-none"
        />
      )}

      {showNewMessage && !isFollowing && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-[var(--panel-inset)] left-1/2 z-10 -translate-x-1/2 rounded-full border border-glass-border glass glass-shadow-xs px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {"\u2193"} New Messages
          </button>
        </div>
      )}

      <div className="flex shrink-0 justify-end pb-2 pr-3">
        <button
          onClick={toggleFollow}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
            "border glass-shadow-xs",
            isFollowing
              ? "border-accent-blue/30 bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25"
              : "border-glass-border glass text-muted-foreground hover:text-foreground",
          )}
        >
          {"\u2193"} Follow
        </button>
      </div>

      <ChatRuntimeCompactStrips sessionId={activeSessionKey} />

      <ChatInput
        additionalDisabled={chatInputDisabled}
        isOtherNodeSession={isOtherNodeSession}
        fileUploadUrl={fileUploadUrl}
      />
    </div>
  );
}
