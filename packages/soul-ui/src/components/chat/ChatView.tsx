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
 * - focusEventId 하이라이트는 `itemsRendered` 콜백에서 `scrollerRef` 범위로 한정한 querySelector로 처리.
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
  decideFollowOnAtBottomChange,
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
}

export function ChatView({
  chatInputDisabled = false,
  isOtherNodeSession = false,
  fileUploadUrl,
  showHeader = true,
}: ChatViewProps = {}) {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const activeSessionSummary = useDashboardStore((s) => s.activeSessionSummary);
  const focusEventId = useDashboardStore((s) => s.focusEventId);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  /**
   * 채팅창 좌표 정본 — store에서 직접 select.
   *
   * processHistoryEvents가 grouped 차분만큼 atomic 갱신한다.
   * 같은 set() 안에서 tree와 함께 갱신되므로 1렌더 사이클 정합이 보장된다.
   */
  const chatPrependedCount = useDashboardStore((s) => s.chatPrependedCount);
  /**
   * 마지막 prepend 시각 — atBottom=true settle 가드용 (decideFollowOnAtBottomChange).
   * processHistoryEvents의 set() 안에서 chatPrependedCount와 함께 atomic 갱신되므로
   * 이 selector도 chatPrependedCount와 같은 렌더 사이클에 갱신된다.
   */
  const chatLastPrependAtMs = useDashboardStore((s) => s.chatLastPrependAtMs);
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
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  const {
    scrollerRef,
    bindScrollerElement,
    scheduleVisuallyFirstItem,
  } = useChatViewportRetention({
    activeSessionKey,
    grouped: timelineItems,
    firstItemIndex,
    isFollowing,
    recordFirstVisibleKey,
  });
  const history = useMessageHistoryBuffer(activeSessionKey, scrollerRef);
  const notifyHistoryViewportGeometry = history.notifyViewportGeometry;
  const bindChatScroller = useCallback((ref: HTMLElement | Window | null) => {
    bindScrollerElement(ref);
    notifyHistoryViewportGeometry();
  }, [bindScrollerElement, notifyHistoryViewportGeometry]);
  useLayoutEffect(() => {
    notifyHistoryViewportGeometry();
  }, [history.loading, notifyHistoryViewportGeometry, timelineItems]);
  const resolveVirtuosoFollowOutput = useCallback(
    () => resolveFollowOutput(isFollowingRef.current),
    [],
  );
  /**
   * 같은 focusEventId에 대해 `itemsRendered`가 반복 호출되어도 하이라이트 타이머가
   * 중첩되지 않도록 1회 처리 후 여기에 기록한다. 세션 전환 시 null로 초기화.
   */
  const handledFocusRef = useRef<number | null>(null);
  const bottomFocusedSessionRef = useRef<string | null>(null);
  const initialBottomFocusPendingSessionRef = useRef<string | null>(
    activeSessionKey,
  );

  /**
   * 세션 전환 시점 기록 (auto-follow 가드용).
   *
   * `key={activeSessionKey}`는 `<Virtuoso>`에만 붙어 있어 ChatView 컴포넌트
   * 자체는 재마운트되지 않는다. 따라서 useRef 초기값은 최초 마운트 1회만 유효.
   * 세션 전환 시 갱신은 render 본체에서 prev/curr 비교로 즉시 수행한다 —
   * useEffect로 미루면 Virtuoso remount 직후의 첫 atBottomStateChange(false)
   * 콜백이 effect보다 먼저 호출되어 sessionMs가 직전 세션 시각 기준이 되고
   * 가드가 무력화될 수 있다.
   *
   * decideFollowOnAtBottomChange가 이 ref 기반 sessionMs로 measure 깜빡임 윈도를
   * 판정한다.
   */
  const sessionStartedAtRef = useRef<number>(performance.now());
  const prevSessionKeyForFollowRef = useRef<string | null>(activeSessionKey);
  if (prevSessionKeyForFollowRef.current !== activeSessionKey) {
    prevSessionKeyForFollowRef.current = activeSessionKey;
    sessionStartedAtRef.current = performance.now();
    bottomFocusedSessionRef.current = null;
    initialBottomFocusPendingSessionRef.current = activeSessionKey;
  }

  const scrollToBottomWithBehavior = useCallback(
    (behavior: "auto" | "smooth") => {
      if (bottomScrollLocation === null) return;
      virtuosoRef.current?.scrollToIndex({
        ...bottomScrollLocation,
        behavior,
      });
    },
    [bottomScrollLocation],
  );

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
    if (
      bottomScrollLocation !== null &&
      (isInitialBottomFocusPending ||
        shouldScrollToBottomOnTreeChange(isFollowingRef.current, timelineItems.length))
    ) {
      requestAnimationFrame(() => {
        scrollToBottomWithBehavior("auto");
        requestAnimationFrame(() => {
          scrollToBottomWithBehavior("auto");
        });
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

  // 세션 변경 시: follow 리셋 + 이전 세션의 focusEventId 잔재 정리.
  // 다른 세션에 우연히 같은 eventId가 존재하면 엉뚱한 메시지를 하이라이트할 수 있으므로
  // 세션이 바뀌는 순간 focusEventId와 handledFocusRef를 모두 비운다.
  // 실제 스크롤 위치 리셋은 Virtuoso `key={activeSessionKey}` 재마운트로 처리된다.
  useEffect(() => {
    setIsFollowing(true);
    setShowNewMessage(false);
    setFocusEventId(null);
    handledFocusRef.current = null;
  }, [activeSessionKey, setFocusEventId]);

  // 검색 결과 클릭 시: focusEventId에 해당하는 메시지로 스크롤.
  // 하이라이트는 itemsRendered 콜백에서 DOM 쿼리 후 적용.
  useEffect(() => {
    if (!focusEventId || timelineItems.length === 0) return;
    const targetIndex = findFocusIndex(timelineItems, focusEventId);
    if (targetIndex < 0) return; // 다음 treeVersion tick에서 재시도
    virtuosoRef.current?.scrollToIndex({
      index: targetIndex + firstItemIndex,
      align: "center",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEventId, treeVersion, timelineItems, firstItemIndex]);

  const scrollToBottom = useCallback(() => {
    scrollToBottomWithBehavior("smooth");
    setIsFollowing(true);
    setShowNewMessage(false);
  }, [scrollToBottomWithBehavior]);

  const toggleFollow = useCallback(() => {
    setIsFollowing((prev) => {
      const next = !prev;
      if (next && bottomScrollLocation !== null) {
        scrollToBottomWithBehavior("smooth");
        setShowNewMessage(false);
      }
      return next;
    });
  }, [bottomScrollLocation, scrollToBottomWithBehavior]);

  const VirtuosoHeader = useCallback(
    () => (
      <ChatHistoryStatus
        loading={history.loading}
        reachedTop={history.reachedTop}
        blockedReason={history.blockedReason}
        onRetry={() => history.requestOlder("manual")}
      />
    ),
    [history.blockedReason, history.loading, history.reachedTop, history.requestOlder],
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
      {timelineItems.length === 0 && (
        <ChatHistoryStatus
          loading={history.loading}
          reachedTop={history.reachedTop}
          blockedReason={history.blockedReason}
          onRetry={() => history.requestOlder("manual")}
          showReachedTop={false}
        />
      )}
      {timelineItems.length === 0 && !history.loading && history.blockedReason === null && (
        <div className="p-5 text-center text-muted-foreground text-sm">
          Waiting for events...
        </div>
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
            if (isInitialBottomFocusPending) {
              if (!atBottom) return;
              initialBottomFocusPendingSessionRef.current = null;
              bottomFocusedSessionRef.current = activeSessionKey;
              setIsFollowing(true);
              setShowNewMessage(false);
              return;
            }
            // 두 가지 measure 깜빡임을 모두 가드한다:
            //   - 세션 전환 직후 atBottom=false 깜빡임 (sessionMs 기반)
            //   - prepend 직후 atBottom=true 깜빡임 (prependAgeMs 기반)
            // 헬퍼가 null을 반환하면 isFollowing 변경하지 않음.
            const sessionMs = performance.now() - sessionStartedAtRef.current;
            const prependAgeMs =
              chatLastPrependAtMs === null
                ? null
                : performance.now() - chatLastPrependAtMs;
            const next = decideFollowOnAtBottomChange(atBottom, sessionMs, prependAgeMs);
            if (next !== null) {
              setIsFollowing(next);
            }
            // showNewMessage는 atBottom=true 보고가 신뢰 가능한지와 무관하게
            // 사용자가 끝에 닿았다는 raw 신호로만 끄면 충분.
            if (atBottom) setShowNewMessage(false);
          }}
          startReached={() => {
            history.requestOlder("automatic");
          }}
          totalListHeightChanged={notifyHistoryViewportGeometry}
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
            if (focusEventId == null) return;
            // 이미 이 focusEventId를 처리했다면 중복 예약 방지
            if (handledFocusRef.current === focusEventId) return;
            // scrollerRef로 virtuoso 내부 스크롤러 DOM 범위 한정 (document 전역 쿼리 금지)
            const el = scrollerRef.current?.querySelector(
              `[data-tree-node-id$="-${focusEventId}"]`,
            ) as HTMLElement | null;
            if (!el) return;
            handledFocusRef.current = focusEventId;
            el.classList.add("chat-focus-ring");
            window.setTimeout(() => {
              el.classList.remove("chat-focus-ring");
              setFocusEventId(null);
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
