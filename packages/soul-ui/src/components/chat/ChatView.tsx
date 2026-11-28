import { resolveLanguage } from "@soulstream/i18n";
/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 * 500줄 초과: 기존 채팅 렌더·follow·검색·입력의 소유 경계를 유지하는 국소 이력 로드 수리입니다.
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링한다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송한다.
 *
 * Phase 4 재설계:
 * - react-virtuoso + `alignToBottom + followOutput="auto"` 로 "첫 paint가 이미 최하단" 을 달성.
 *   이동 궤적 없이 하단 고정.
 * - prepend는 `firstItemIndex -= N`: 기본 행은 store count, 원고형 행은 투영 후 증가량.
 * - 과거 로드는 startReached/viewport geometry/수동 재시도가 하나의 controller를 사용.
 * - focusEventId 하이라이트는 `itemsRendered` 콜백과 렌더 뒤 도착한 요청의 effect에서 Virtuoso 행 key로 찾는다.
 * - 세션 전환은 Virtuoso `key={activeSessionKey}` 재마운트로 처리.
 *
 * Follow mode: 새 메시지 도착 시 자동 스크롤 follow/unfollow 토글.
 * Tool grouping: 연속된 tool 메시지를 접기/펼치기 그룹으로 묶어 표시.
 */

import { useTranslation } from "react-i18next";
import { useMemo, useRef, useEffect, useState, useCallback, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown, ArrowDownToLine } from "lucide-react";
import { useDashboardStore, type ChatSessionStoreScope } from "../../stores/dashboard-store";
import { DashboardIconCap } from "../DashboardIconCap";
import { FrameLoading } from "../FrameLoading";
import { ChatStoreScopeProvider, useChatFlattenTree, useChatStore, useChatStoreApi } from "../../stores/chat-store-scope";
import { projectPersistentTurnUsage } from "../../lib/persistent-turn-usage-projection";
import { projectPersistentWorkDetails } from "../../lib/persistent-work-details-projection";
import { projectChatOutputAttachments } from "../../lib/chat-output-attachment-projection";
import { fetchDeliveryFailures } from "../../lib/delivery-failures";
import { projectManuscriptAssignedCardContexts } from "../../lib/assigned-card-context-projection";
import { placeTurnSummariesAtCompleteCaptions } from "../../lib/turn-summary-projection";
import {
  projectManuscriptMessages,
  projectManuscriptSilentResponses,
} from "../../lib/manuscript-agent-message-projection";
import { projectPersistentChatDisplayMessages } from "../../lib/persistent-jev-candidates";
import { projectHiddenInputTurns } from "../../lib/persistent-cache-keepalive";
import { ChatInput } from "../ChatInput";
import { useLlmContext } from "./hooks";
import { groupManuscriptMessages, groupMessages } from "../../lib/grouping";
import { VirtualizedItem } from "./VirtualizedItem";
import { ChatManuscriptList, ChatManuscriptFooter, isManuscriptNarration, manuscriptActivityNarrationIds, manuscriptItemSpacingClass } from "./ChatManuscriptList";
import { useMessageHistoryBuffer, VIEWPORT_FILL_MARGIN_PX } from "./useMessageHistoryBuffer";
import { hasFilledHistoryViewport } from "./ChatView.viewport-geometry";
import {
  areMessageGroupsRenderEqual,
  findFocusIndex,
  getBottomScrollLocation,
  getInitialTopMostItemIndex,
  hasNewMessageTailChange,
  MAX_SEARCH_FOCUS_HISTORY_PAGES,
  messageOrGroupKey,
  resolveFocusEventId,
  toolGroupExpansionKey,
} from "./ChatView.reverse-helpers";
import { useChatLogicalInsertionCoordinate } from "./useChatLogicalInsertionCoordinate";
import { useChatViewportRetention } from "./useChatViewportRetention";
import {
  resolveFollowOutput,
  shouldScrollToBottomOnTreeChange,
} from "./ChatView.follow-helpers";
import { ChatRuntimeCompactStrips } from "./ChatRuntimeCompactStrips";
import { useChatTypography } from "./useChatTypography";
import { buildChatTimelineItems, type ChatTimelineItem } from "./ChatView.thinking-indicator";
import { ChatHistoryStatus } from "./ChatHistoryStatus";
import type { PendingChatSend } from "../../stores/dashboard-store-types";
import type { PendingChatSendActions } from "./pending-chat-send";
import { ChatUiControllerProvider, ChatUiOperationsBridge } from "../chat-ui/ChatUiControllerProvider";
import type { ChatUiComposerHandle, RegisterGeneratedTextActions } from "../chat-ui/chat-ui-composer";
import { collapseReportTimeline } from "@soulstream/wire-schema/persistent-report";

export interface ChatViewProps {
  registerChatUiOperations?: import('../chat-ui/chat-ui-composer').RegisterChatUiOperations;
  registerGeneratedTextActions?: RegisterGeneratedTextActions;
  chatInputDisabled?: boolean;
  fileUploadUrl?: string;
  historyEnabled?: boolean;
  transcriptFallback?: ReactNode;
  /** Status text shares the list gutter; boxed content aligns with the composer. */
  transcriptFallbackLayout?: "status" | "content" | "fill";
  showRuntimeStrips?: boolean;
  presentation?: "default" | "manuscript";
  composerAnchorRef?: RefObject<HTMLDivElement | null>;
  /** Optional in-memory session scope for a second, independent transcript. */
  storeScope?: ChatSessionStoreScope;
  /** Receives only LLM continuation session changes from this transcript. */
  onSessionChange?: (sessionId: string) => void;
}

function isGenerationDivider(item: ChatTimelineItem): boolean {
  return item.type === "single" && item.msg.treeNodeType === "generation_started";
}

// 초점 대상 행은 Virtuoso 행 key로 찾고, 스크롤 상자의 보이는 영역과 겹치는지로 화면 안을 판정한다.
function findFocusRowElement(
  scroller: HTMLElement | null,
  targetKey: string,
): HTMLElement | null {
  const targetRow = Array.from(
    scroller?.querySelectorAll<HTMLElement>("[data-chat-item-key]") ?? [],
  ).find((row) => row.dataset.chatItemKey === targetKey);
  return targetRow?.querySelector<HTMLElement>("[data-tree-node-id]") ?? null;
}

function isRowInScrollViewport(row: HTMLElement, scroller: HTMLElement): boolean {
  const rowRect = row.getBoundingClientRect();
  const viewportRect = scroller.getBoundingClientRect();
  return rowRect.bottom > viewportRect.top && rowRect.top < viewportRect.bottom;
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

export function ChatView(props: ChatViewProps = {}) {
  const content = <ChatViewContent {...props} />;
  return props.storeScope ? (
    <ChatStoreScopeProvider scope={props.storeScope}>{content}</ChatStoreScopeProvider>
  ) : content;
}

function ChatViewContent({
  chatInputDisabled = false,
  fileUploadUrl,
  historyEnabled = true,
  transcriptFallback,
  transcriptFallbackLayout = "status",
  showRuntimeStrips = true,
  presentation = "default",
  composerAnchorRef,
  onSessionChange,
  registerGeneratedTextActions: registerExternalGeneratedActions,
  registerChatUiOperations,
}: Omit<ChatViewProps, "storeScope"> = {}) {
  const { t, i18n } = useTranslation();
  const language = resolveLanguage(i18n.resolvedLanguage, []);
  const tree = useChatStore((s) => s.tree);
  const treeVersion = useChatStore((s) => s.treeVersion);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const persistentSessionDisplaySettings = useChatStore((s) => s.persistentSessionDisplaySettings);
  const pendingChatSend = useDashboardStore((s) => (
    activeSessionKey ? s.pendingChatSends[activeSessionKey] : undefined
  ));
  const deliveryFailures = useDashboardStore((s) => (
    activeSessionKey ? s.deliveryFailuresBySession[activeSessionKey] : undefined
  ));
  const deliveryFailureRefresh = useDashboardStore((s) => (
    activeSessionKey ? s.deliveryFailureRefreshBySession[activeSessionKey] ?? 0 : 0
  ));
  const setDeliveryFailures = useDashboardStore((s) => s.setDeliveryFailures);
  const activeSessionSummary = useChatStore((s) => s.activeSessionSummary);
  const requestedFocusEventId = useChatStore((s) => (
    s.focusEventSessionId === null || s.focusEventSessionId === s.activeSessionKey
      ? s.focusEventId
      : null
  ));
  const focusEventTarget = useChatStore((s) => s.focusEventTarget);
  const focusEventRequestId = useChatStore((s) => s.focusEventRequestId);
  const chatStore = useChatStoreApi();
  const flattenMessages = useChatFlattenTree();
  const generatedTextActionsRef = useRef<ChatUiComposerHandle | null>(null);
  const registerGeneratedTextActions = useCallback<RegisterGeneratedTextActions>(handle => {
    generatedTextActionsRef.current = handle;
    registerExternalGeneratedActions?.(handle);
  }, [registerExternalGeneratedActions]);
  const appendGeneratedText = useCallback<ChatUiComposerHandle['appendGeneratedText']>((sessionId, text) =>
    generatedTextActionsRef.current?.appendGeneratedText(sessionId, text) ?? { ok: false, reason: "unavailable" }, []);
  const pendingSendActionsRef = useRef<PendingChatSendActions | null>(null);
  const registerPendingSendActions = useCallback((actions: PendingChatSendActions | null) => {
    pendingSendActionsRef.current = actions;
  }, []);
  const handlePendingRetry = useCallback((pending: PendingChatSend) => {
    if (activeSessionKey) {
      pendingSendActionsRef.current?.retry(activeSessionKey, pending);
    }
  }, [activeSessionKey]);
  const handlePendingRestore = useCallback((pending: PendingChatSend) => {
    if (activeSessionKey) {
      pendingSendActionsRef.current?.restore(activeSessionKey, pending);
    }
  }, [activeSessionKey]);
  const handleRetryDelivery = useCallback((message: { text: string; attachmentPaths: readonly string[] }) => {
    if (activeSessionKey) {
      pendingSendActionsRef.current?.retryDelivery(activeSessionKey, message);
    }
  }, [activeSessionKey]);
  const handleRestoreDelivery = useCallback((text: string) => {
    if (activeSessionKey) {
      pendingSendActionsRef.current?.restoreDelivery(activeSessionKey, text);
    }
  }, [activeSessionKey]);
  const setFocusEventId = useChatStore((s) => s.setFocusEventId);
  /**
   * 채팅창 좌표 정본 — store에서 직접 select.
   *
   * processHistoryEvents가 기본 grouped 차분만큼 atomic 갱신한다.
   * 원고형은 아래 좌표 훅에서 투영된 행 증가량으로 바꾼다.
   * 같은 set() 안에서 tree와 함께 갱신되므로 1렌더 사이클 정합이 보장된다.
   */
  const chatPrependedCount = useChatStore((s) => s.chatPrependedCount);
  const {chatFontSize,chatTypographyStyle}=useChatTypography();
  const llmContext = useLlmContext();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const isManuscript = presentation === "manuscript";
  const turnUsageMode = persistentSessionDisplaySettings?.sessionId === activeSessionKey
    ? persistentSessionDisplaySettings.turnUsageMode ?? "collapsed"
    : "collapsed";
  const showWorkDetails = persistentSessionDisplaySettings?.sessionId === activeSessionKey
    ? persistentSessionDisplaySettings.showWorkDetails
    : true;
  const flattenedMessages = useMemo(
    () => flattenMessages(tree, { includePersistentTurnUsage: isManuscript, language }),
    [flattenMessages, isManuscript, language, tree, treeVersion],
  );
  const messages = useMemo(
    () => projectChatOutputAttachments(flattenedMessages),
    [flattenedMessages],
  );
  const hiddenInputProjection = useMemo(
    () => projectHiddenInputTurns(isManuscript
      ? projectManuscriptAssignedCardContexts(placeTurnSummariesAtCompleteCaptions(messages))
      : messages),
    [isManuscript, messages],
  );
  const transcriptMessages = useMemo(
    () => {
      if (!isManuscript) return hiddenInputProjection.messages;
      const silentResponsesFiltered = projectManuscriptSilentResponses(hiddenInputProjection.messages);
      return projectPersistentTurnUsage(
        projectPersistentWorkDetails(silentResponsesFiltered, showWorkDetails),
        turnUsageMode,
        language,
      );
    },
    [isManuscript, hiddenInputProjection, language, showWorkDetails, turnUsageMode],
  );
  const visibleMessages = useMemo(
    () => {
      const visible = projectPersistentChatDisplayMessages(
        transcriptMessages,
        persistentSessionDisplaySettings?.sessionId === activeSessionKey
          ? {
            show_generation_separator: persistentSessionDisplaySettings.showGenerationSeparator,
            show_jev_candidates: persistentSessionDisplaySettings.showJevCandidates,
          }
          : null,
      );
      const projected = isManuscript ? projectManuscriptMessages(visible) : visible;
      return collapseReportTimeline(projected, {
        lineOf: (message) => message.reportTimeline ?? null,
        closuresOf: (message) => message.reportTimelineClosures ?? null,
        isConversation: (message) => message.role === "user"
          || message.role === "intervention"
          || (message.role === "assistant" && message.treeNodeType !== "thinking"),
        withStatus: (message, status) => ({ ...message, reportTimeline: { ...message.reportTimeline!, status } }),
        withLine: (message, reportTimeline) => ({ ...message, reportTimeline }),
      });
    },
    [isManuscript, transcriptMessages, persistentSessionDisplaySettings, activeSessionKey],
  );
  const manuscriptGrouped = useMemo(
    () => (isManuscript ? groupManuscriptMessages(visibleMessages) : null),
    [isManuscript, visibleMessages],
  );
  const activityNarrationIds = useMemo(
    () => (manuscriptGrouped === null ? new Set<string>() : manuscriptActivityNarrationIds(manuscriptGrouped)),
    [manuscriptGrouped],
  );
  const grouped = useMemo(
    () => {
      if (manuscriptGrouped === null) return groupMessages(visibleMessages);
      return showWorkDetails
        ? manuscriptGrouped
        : manuscriptGrouped.filter((item) => item.type !== "activity-group");
    },
    [manuscriptGrouped, showWorkDetails, visibleMessages],
  );
  const chatStatus = activeSessionSummary?.status ?? "unknown";
  const timelineItems = useMemo(
    () => buildChatTimelineItems(grouped, visibleMessages, chatStatus, pendingChatSend, hiddenInputProjection.suppressStreaming),
    [grouped, visibleMessages, chatStatus, pendingChatSend, hiddenInputProjection.suppressStreaming],
  );
  const focusEventId = resolveFocusEventId(
    timelineItems,
    requestedFocusEventId,
    focusEventTarget,
  );
  const { firstItemIndex, recordFirstVisibleKey } =
    useChatLogicalInsertionCoordinate(
      timelineItems,
      activeSessionKey,
      chatPrependedCount,
      isManuscript,
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
  const [isFollowing, setIsFollowing] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [expandedToolGroups, setExpandedToolGroups] = useState<{
    sessionId: string | null;
    keys: ReadonlySet<string>;
  }>({ sessionId: activeSessionKey, keys: new Set() });
  const [focusHistoryCappedRequestId, setFocusHistoryCappedRequestId] = useState<number | null>(null);
  const handleToolGroupExpansionChange = useCallback((key: string, expanded: boolean) => {
    setExpandedToolGroups((current) => {
      const keys = current.sessionId === activeSessionKey
        ? new Set(current.keys)
        : new Set<string>();
      if (expanded) keys.add(key);
      else keys.delete(key);
      return { sessionId: activeSessionKey, keys };
    });
  }, [activeSessionKey]);
  const prevTreeVersion = useRef(treeVersion);
  const prevVisibleItemsRef = useRef(timelineItems);
  // ref로 effect 내부에서 최신 상태를 참조 (effect deps에서 제거하여 불필요한 재실행 방지)
  const isFollowingRef = useRef(true);
  const isAtBottomRef = useRef(false);
  const handledFocusRef = useRef<number | null>(null);
  const focusedScrollRequestRef = useRef<number | null>(null);
  const focusRingOwnersRef = useRef(new WeakMap<HTMLElement, number>());
  const focusScrollRetryRef = useRef<{
    key: string | null;
    attempts: number;
    frame: number | null;
  }>({ key: null, attempts: 0, frame: null });
  const focusHistoryCrawlRef = useRef({ requestId: -1, pagesRequested: 0 });
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
  const requestOlderDuringExploration = useCallback((scroller: HTMLElement | null) => {
    if (
      activeSessionKey === null
      || olderHistoryIntentSessionRef.current !== activeSessionKey
      || (scroller !== null && scroller.scrollTop > 800)
    ) return;
    requestOlderRef.current("automatic");
  }, [activeSessionKey]);
  const handleUserViewportInput = useCallback((event: Event) => {
    if (activeSessionKey === null) return;
    const scroller = event.currentTarget instanceof HTMLElement
      ? event.currentTarget
      : null;
    // 고리를 붙인 초점 요청은 사용자가 직접 스크롤하면 끝낸다. 높이 보정 맞추기가 사용자 스크롤과 다투지 않는다.
    const endShownFocusOnUserScroll = () => {
      const focus = chatStore.getState();
      if (
        focus.focusEventId !== null
        && focus.focusEventSessionId === activeSessionKey
        && handledFocusRef.current === focus.focusEventRequestId
      ) setFocusEventId(null);
    };
    const markOlderExploration = () => {
      endShownFocusOnUserScroll();
      olderHistoryIntentSessionRef.current = activeSessionKey;
      initialBottomFocusPendingSessionRef.current = null;
      bottomFocusedSessionRef.current = activeSessionKey;
      isFollowingRef.current = false;
      setIsFollowing(false);
      requestOlderDuringExploration(scroller);
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
      requestOlderDuringExploration(scroller);
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
        endShownFocusOnUserScroll();
        clearOlderHistoryIntent();
      }
      return;
    }
    if (event.type === "wheel") {
      const deltaY = (event as WheelEvent).deltaY;
      if (canNestedScrollerConsumeVerticalInput(event.target, scroller, deltaY)) return;
      if (deltaY < 0) markOlderExploration();
      else if (deltaY > 0) {
        endShownFocusOnUserScroll();
        clearOlderHistoryIntent();
      }
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
        endShownFocusOnUserScroll();
        clearOlderHistoryIntent();
      }
    }
  }, [
    activeSessionKey,
    chatStore,
    clearOlderHistoryIntent,
    requestOlderDuringExploration,
    setFocusEventId,
  ]);
  const scrollItemToOffset = useCallback((index: number, offset: number) => {
    // scrollToIndex addresses the current data array, not firstItemIndex keys.
    virtuosoRef.current?.scrollToIndex({ index, align: "start", offset: -offset });
  }, []);
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
    scrollItemToOffset,
    onUserViewportInput: handleUserViewportInput,
  });
  // 보이는 영역에 들어온 대상 행에 고리를 붙이고 2초 뒤 지운다.
  const attachFocusRing = useCallback((el: HTMLElement) => {
    if (focusEventId == null) return;
    const requestId = focusEventRequestId;
    // Virtuoso가 행 DOM을 다시 만들면 붙였던 클래스가 새 행에 남지 않는다.
    // 같은 요청의 고리가 살아 있는 행에 없으면 그 행에 다시 붙인다.
    if (handledFocusRef.current === requestId && el.classList.contains("chat-focus-ring")) return;
    handledFocusRef.current = requestId;
    focusRingOwnersRef.current.set(el, requestId);
    el.classList.add("chat-focus-ring");
    window.setTimeout(() => {
      if (focusRingOwnersRef.current.get(el) === requestId) {
        el.classList.remove("chat-focus-ring");
        focusRingOwnersRef.current.delete(el);
      }
      const currentFocus = chatStore.getState();
      if (
        currentFocus.focusEventId === focusEventId
        && currentFocus.focusEventSessionId === activeSessionKey
        && currentFocus.focusEventRequestId === requestId
      ) {
        setFocusEventId(null);
      }
    }, 2000);
  }, [activeSessionKey, chatStore, focusEventId, focusEventRequestId, setFocusEventId]);
  // 대상 행의 위치 판정과 다시 스크롤은 다음 프레임에 한다. Virtuoso는 itemsRendered와
  // totalListHeightChanged를 DOM 반영보다 먼저 내므로 그 순간의 DOM은 이전 렌더일 수 있다.
  // - 행이 보이는 영역 안이면 고리를 붙인다.
  // - 행이 DOM에 있는데 영역 밖이면(추정 높이로 빗나감, 높이 보정으로 밀림) 횟수에 들지 않고 다시 맞춘다.
  //   고리를 붙인 뒤에는 고리 수명(2초 뒤 focusEventId가 지워질 때까지)이 이 맞추기의 한도다.
  // - 행이 DOM에 없으면 행 찾기 재스크롤이며 고리를 붙이기 전까지 요청마다 3회다. 목록이 아직 행을
  //   하나도 그리지 않았으면 찾을 대상이 없으므로 세지 않고 다음 렌더 신호를 기다린다.
  const scheduleFocusAlignment = useCallback(() => {
    if (
      activeSessionKey === null
      || requestedFocusEventId === null
      || focusEventId === null
    ) return;
    const requestKey = `${activeSessionKey}:${requestedFocusEventId}:${focusEventRequestId}`;
    const retry = focusScrollRetryRef.current;
    if (retry.key !== requestKey) {
      retry.key = requestKey;
      retry.attempts = 0;
    }
    if (retry.frame !== null) return;
    retry.frame = window.requestAnimationFrame(() => {
      retry.frame = null;
      const state = chatStore.getState();
      if (
        state.activeSessionKey !== activeSessionKey
        || state.focusEventId !== requestedFocusEventId
        || state.focusEventSessionId !== activeSessionKey
        || state.focusEventRequestId !== focusEventRequestId
      ) return;
      const targetIndex = findFocusIndex(timelineItems, focusEventId);
      if (targetIndex < 0) return;
      const scroller = scrollerRef.current;
      const row = findFocusRowElement(scroller, messageOrGroupKey(timelineItems[targetIndex]));
      if (row && scroller && isRowInScrollViewport(row, scroller)) {
        attachFocusRing(row);
        return;
      }
      if (!row) {
        if (scroller?.querySelector("[data-chat-item-key]") == null) return;
        if (handledFocusRef.current !== focusEventRequestId) {
          if (retry.attempts >= 3) {
            setFocusEventId(null);
            return;
          }
          retry.attempts += 1;
        }
      }
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
    attachFocusRing,
    cancelPendingRetention,
    chatStore,
    focusEventId,
    focusEventRequestId,
    scrollerRef,
    setFocusEventId,
    requestedFocusEventId,
    timelineItems,
  ]);
  useEffect(() => () => {
    const frame = focusScrollRetryRef.current.frame;
    if (frame !== null) window.cancelAnimationFrame(frame);
    focusScrollRetryRef.current = { key: null, attempts: 0, frame: null };
  }, [activeSessionKey, focusEventRequestId]);
  // 포커스 고리는 Virtuoso 렌더 콜백, 높이 변화 콜백과, 행이 이미 렌더된 뒤 늦게 도착한 요청의 effect가 함께 쓴다.
  // 그 순간 이미 보이는 행이면 바로 고리를 붙이고, 위치 판정은 다음 프레임에 다시 한다.
  const applyFocusRing = useCallback(() => {
    if (focusEventId == null) return;
    const targetIndex = findFocusIndex(timelineItems, focusEventId);
    if (targetIndex < 0) return;
    const scroller = scrollerRef.current;
    const el = findFocusRowElement(scroller, messageOrGroupKey(timelineItems[targetIndex]));
    if (el && scroller && isRowInScrollViewport(el, scroller)) attachFocusRing(el);
    scheduleFocusAlignment();
  }, [
    attachFocusRing,
    focusEventId,
    scheduleFocusAlignment,
    scrollerRef,
    timelineItems,
  ]);
  const history = useMessageHistoryBuffer(activeSessionKey, scrollerRef, historyEnabled && transcriptFallback == null, isManuscript);
  requestOlderRef.current = history.requestOlder;

  // 카드 #1524: 사람 발신 전달 실패 목록을 채팅 열림(첫 history fetch)·세션 SSE
  // 재연결(historyEnabled false→true)·전역 session_delivery_failed 신호에서 다시 읽는다.
  // 응답이 늦게 와 세션이 바뀌었으면 그 응답은 버린다.
  useEffect(() => {
    if (!activeSessionKey || !historyEnabled) return;
    let cancelled = false;
    void fetchDeliveryFailures(activeSessionKey)
      .then((failures) => {
        if (!cancelled) setDeliveryFailures(activeSessionKey, failures);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeSessionKey, historyEnabled, deliveryFailureRefresh, setDeliveryFailures]);
  useEffect(() => {
    if (focusHistoryCrawlRef.current.requestId !== focusEventRequestId) {
      focusHistoryCrawlRef.current = { requestId: focusEventRequestId, pagesRequested: 0 };
      setFocusHistoryCappedRequestId(null);
    }
    if (
      activeSessionKey === null
      || requestedFocusEventId === null
      || focusEventId === null
    ) return;
    if (findFocusIndex(timelineItems, focusEventId) >= 0) return;
    if (
      history.reachedTop
      || history.loading
      || !history.canLoadOlder
      || history.blockedReason === "error"
    ) return;
    if (focusHistoryCrawlRef.current.pagesRequested >= MAX_SEARCH_FOCUS_HISTORY_PAGES) {
      setFocusHistoryCappedRequestId(focusEventRequestId);
      return;
    }
    // Search navigation is explicit intent, capped to five pages. The existing
    // older-history control remains the user's path to continue beyond that window.
    focusHistoryCrawlRef.current.pagesRequested += 1;
    history.requestOlder("manual");
  }, [
    activeSessionKey,
    focusEventId,
    focusEventRequestId,
    history.blockedReason,
    history.canLoadOlder,
    history.loading,
    history.reachedTop,
    history.requestOlder,
    requestedFocusEventId,
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
  useEffect(() => {
    if (
      timelineItems.length === 0
      && history.canLoadOlder
      && !history.loading
      && history.blockedReason === null
    ) history.requestOlder("automatic");
  }, [history.canLoadOlder, history.loading, history.blockedReason, history.requestOlder, timelineItems.length]);
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
      && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= (isManuscript ? 0 : 1)
    ) return;
    scrollToBottomWithBehavior("auto");
  }, [isManuscript, scrollToBottomWithBehavior, scrollerRef]);
  const handleTotalListHeightChanged = useCallback(() => {
    notifyHistoryViewportGeometry();
    // 행의 실제 높이는 Markdown/접힌 도구 렌더 뒤에도 바뀔 수 있다. Follow는
    // 명시적 사용자 의도이므로 켜져 있는 동안에는 그 높이 변화도 하단에 고정한다.
    maintainBottomIfFollowing();
    // 추정 높이가 뒤늦게 보정되면 같은 렌더 범위에서도 초점 행이 화면 밖으로 밀릴 수 있다.
    applyFocusRing();
  }, [applyFocusRing, maintainBottomIfFollowing, notifyHistoryViewportGeometry]);

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

  // 새 이벤트 시: following이 아니면 "새 메시지" 배너 표시.
  // following 중이거나 초기 bottom focus가 아직 완료되지 않았다면 하단을 유지한다.
  useEffect(() => {
    if (treeVersion === prevTreeVersion.current) return;
    prevTreeVersion.current = treeVersion;
    const visibleItemsChanged = !areMessageGroupsRenderEqual(
      prevVisibleItemsRef.current,
      timelineItems,
    );
    const newMessageItemsChanged = hasNewMessageTailChange(
      prevVisibleItemsRef.current.filter((item) => !isGenerationDivider(item)),
      timelineItems.filter((item) => !isGenerationDivider(item)),
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
      presentation === "manuscript"
      && !isFollowingRef.current
      && isAtBottomRef.current
    ) {
      isFollowingRef.current = true;
      setIsFollowing(true);
      setShowNewMessage(false);
    }
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
    if (!isFollowingRef.current && timelineItems.length > 0 && newMessageItemsChanged) {
      setShowNewMessage(true);
    }
  }, [
    treeVersion,
    timelineItems,
    bottomScrollLocation,
    activeSessionKey,
    presentation,
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

  // 포커스 요청이 Virtuoso 렌더 콜백보다 늦게 도착해도(행이 이미 렌더된 뒤) 고리를 붙인다.
  useEffect(() => {
    applyFocusRing();
  }, [applyFocusRing, focusEventId, focusEventRequestId, timelineItems]);

  const scrollToBottom = useCallback(() => {
    clearOlderHistoryIntent();
    isFollowingRef.current = true;
    scrollToBottomWithBehavior("smooth");
    setIsFollowing(true);
    setShowNewMessage(false);
  }, [clearOlderHistoryIntent, scrollToBottomWithBehavior]);

  const toggleFollow = useCallback(() => {
    const next = !isFollowingRef.current;
    isFollowingRef.current = next;
    setIsFollowing(next);
    if (next && bottomScrollLocation !== null) {
      clearOlderHistoryIntent();
      scrollToBottomWithBehavior("smooth");
      setShowNewMessage(false);
    }
  }, [bottomScrollLocation, clearOlderHistoryIntent, scrollToBottomWithBehavior]);

  const renderHistoryHeader = useCallback(
    () => {
      const status = transcriptFallback ?? <ChatHistoryStatus
        loading={history.loading}
        blockedReason={history.blockedReason}
        onRetry={requestOlderManually}
      />;
      return presentation === "manuscript" ? <div data-slot="chat-manuscript-list-header" className="flow-root pt-6">{status}</div> : status;
    },
    [
      presentation,
      transcriptFallback,
      history.blockedReason,
      history.canLoadOlder,
      history.loading,
      requestOlderManually,
    ],
  );
  const VirtuosoHeader = useCallback(() => renderHistoryHeader(), [renderHistoryHeader]);
  const virtuosoComponents = useMemo(
    () => ({ Header: VirtuosoHeader, ...(presentation === "manuscript" ? { List: ChatManuscriptList, Footer: ChatManuscriptFooter } : {}) }),
    [VirtuosoHeader, presentation],
  );

  if (!activeSessionKey) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t("ui.chat.selectSession")}
      </div>
    );
  }

  return (
    <ChatUiControllerProvider sessionId={activeSessionKey} appendGeneratedText={appendGeneratedText}>
    <ChatUiOperationsBridge register={registerChatUiOperations} />
    <div
      data-slot="chat-root"
      data-chat-font-size={chatFontSize}
      data-chat-first-item-index={firstItemIndex}
      data-chat-item-count={timelineItems.length}
      data-chat-prepended-count={chatPrependedCount}
      style={chatTypographyStyle}
      className={presentation === "manuscript" ? "-mx-1 flex h-full min-h-0 flex-col overflow-hidden px-1 pb-3 pt-3" : "flex h-full min-h-0 flex-col overflow-hidden px-3 pb-3 pt-3"}
      data-chat-presentation={presentation === "manuscript" ? "manuscript" : undefined}
    >
      {transcriptFallback != null ? (
        transcriptFallbackLayout === "fill" ? (
          <div data-slot="chat-transcript-fill" className="flex min-h-0 flex-1 flex-col">{transcriptFallback}</div>
        ) : (
          <div className={presentation === "manuscript" && transcriptFallbackLayout === "status" ? "-mx-1 flex-1 min-h-0" : "flex-1 min-h-0"}>{renderHistoryHeader()}</div>
        )
      ) : <>
      {focusEventId !== null
        && !history.loading
        && findFocusIndex(timelineItems, focusEventId) < 0
        && (
          history.reachedTop
          || focusHistoryCappedRequestId === focusEventRequestId
        ) && (
          <div role="alert" className="shrink-0 px-3 pb-2 text-center text-sm text-accent-red">
            {history.reachedTop
              ? t("ui.chat.searchMissing")
              : t("ui.chat.searchMore", { pages: MAX_SEARCH_FOCUS_HISTORY_PAGES })}
          </div>
        )}
      {timelineItems.length === 0 && (history.loading ? (
        // 보이는 행이 0개인 첫 로딩은 머리 자리 한 줄이 아니라 대화 목록 영역을 채우는 부품으로 기다린다.
        <div data-slot="chat-transcript-fill" className="flex min-h-0 flex-1 flex-col">
          <FrameLoading label={t("ui.chat.loading")} />
        </div>
      ) : (
        <>
          <ChatHistoryStatus
            loading={false}
            blockedReason={history.blockedReason}
            onRetry={requestOlderManually}
          />
          {history.blockedReason === null && (
            <div className="p-5 text-center text-muted-foreground text-sm">
              {chatStatus === "error" ? t("ui.chat.emptyAfterError") : t("ui.chat.waiting")}
            </div>
          )}
        </>
      ))}
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
        followOutput={isFollowing ? resolveVirtuosoFollowOutput : false}
        atBottomStateChange={(atBottom) => {
          isAtBottomRef.current = atBottom;
          const isInitialBottomFocusPending =
            activeSessionKey !== null &&
            initialBottomFocusPendingSessionRef.current === activeSessionKey &&
            bottomFocusedSessionRef.current !== activeSessionKey;
          if (isInitialBottomFocusPending && atBottom) {
            initialBottomFocusPendingSessionRef.current = null;
            bottomFocusedSessionRef.current = activeSessionKey;
            isFollowingRef.current = true;
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
          if (presentation === "manuscript") {
            isFollowingRef.current = true;
            setIsFollowing(true);
          }
          setShowNewMessage(false);
        }}
        startReached={() => {
          if (olderHistoryIntentSessionRef.current === activeSessionKey) {
            requestOlderDuringExploration(null);
          } else {
            const scroller = scrollerRef.current;
            if (scroller !== null && hasFilledHistoryViewport(scroller, VIEWPORT_FILL_MARGIN_PX) === false) {
              history.requestOlder("automatic");
            }
          }
        }}
        totalListHeightChanged={handleTotalListHeightChanged}
        computeItemKey={(_index, item) => messageOrGroupKey(item)}
        itemContent={(index, item) => {
          const narrationItem = item.type === "summary-group" ? item.anchor : item;
          const narration = isManuscript && (
            isManuscriptNarration(item, timelineItems[index - firstItemIndex + 1])
            || (narrationItem.type === "single" && activityNarrationIds.has(narrationItem.msg.treeNodeId))
          );
          const toolGroupKey = (item.type === "tool-group" || item.type === "activity-group") && activeSessionKey !== null
            ? toolGroupExpansionKey(activeSessionKey, item)
            : undefined;
          const toolGroupExpanded = toolGroupKey !== undefined
            && expandedToolGroups.sessionId === activeSessionKey
            && expandedToolGroups.keys.has(toolGroupKey);
          return (
            <div
              data-chat-item-key={messageOrGroupKey(item)}
              className={isManuscript
                ? manuscriptItemSpacingClass(
                  item,
                  timelineItems[index - firstItemIndex - 1],
                  timelineItems[index - firstItemIndex + 1],
                )
                : "contents"}
            >
              <VirtualizedItem
                item={item}
                presentation={presentation}
                narration={narration}
                llmContext={llmContext}
                sessionId={activeSessionKey ?? undefined}
                toolGroupKey={toolGroupKey}
                toolGroupExpanded={toolGroupKey === undefined ? undefined : toolGroupExpanded}
                onToolGroupExpandedChange={handleToolGroupExpansionChange}
                onRetryPending={handlePendingRetry}
                onRestorePending={handlePendingRestore}
                deliveryFailures={deliveryFailures}
                onRetryDelivery={handleRetryDelivery}
                onRestoreDelivery={handleRestoreDelivery}
              />
            </div>
          );
        }}
        itemsRendered={() => {
          // Virtuoso가 data와 spacer DOM을 같은 프레임에 정합한 뒤 geometry를 읽는다.
          // 즉시 읽으면 재배치 중인 overscan 행 또는 빈 중간 프레임을 관찰할 수 있다.
          scheduleVisuallyFirstItem();
          notifyHistoryViewportGeometry();
          // Virtuoso가 추정 높이 보정으로 초기 native bottom 이동을 되돌린 경우도
          // 다음 실제 render range에서 재확인한다. 사용자 위쪽 입력은 ref를 먼저
          // 끄므로 과거 탐색 중인 viewport와 경쟁하지 않는다.
          maintainBottomIfFollowing();
          applyFocusRing();
        }}
          className={presentation === "manuscript" ? "-mx-1 flex-1 min-h-0 overflow-x-hidden overscroll-none [mask-image:linear-gradient(to_bottom,transparent,black_calc(var(--spacing)*6))] [mask-repeat:no-repeat]" : "flex-1 min-h-0 overflow-x-hidden py-2 overscroll-none"}
        />
      )}
      </>}

      {transcriptFallback == null && (presentation === "default" || (showNewMessage && !isFollowing)) && (
        <div className="relative">
          {/* 배너와 단추를 맨 아래 한 줄에 겹쳐 놓는다. 흐름 높이가 없어 목록이 그만큼 넓고,
              묶음의 빈 영역은 pointer-events-none이라 목록의 클릭·선택·휠을 막지 않는다.
              가운데 칸의 배너와 오른쪽 칸의 단추는 items-center로 세로 중심을 맞춘다. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-[var(--panel-inset)] pb-[var(--panel-inset)]">
            {showNewMessage && !isFollowing && (
              presentation === "manuscript" ? (
                <DashboardIconCap
                  appearance="bare"
                  label={t("ui.chat.jumpToNewMessages")}
                  onClick={scrollToBottom}
                  className="pointer-events-auto col-start-2 text-muted-foreground v3-pas-floating-cap"
                >
                  <ArrowDown className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
                </DashboardIconCap>
              ) : (
                <button
                  onClick={scrollToBottom}
                  className="pointer-events-auto col-start-2 justify-self-center rounded-full border border-glass-border glass glass-shadow-xs px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {"\u2193"} {t("ui.chat.newMessages")}
                </button>
              )
            )}
            {presentation === "default" && (
              <DashboardIconCap
                size="small"
                data-slot="chat-follow-toggle"
                label={t("ui.chat.autoScroll")}
                tooltip={isFollowing ? t("ui.chat.autoScrollOn") : t("ui.chat.autoScrollOff")}
                aria-pressed={isFollowing}
                onClick={toggleFollow}
                className="pointer-events-auto col-start-3 justify-self-end"
              >
                <ArrowDownToLine className="size-4" aria-hidden="true" />
              </DashboardIconCap>
            )}
          </div>
        </div>
      )}

      {showRuntimeStrips ? <ChatRuntimeCompactStrips sessionId={activeSessionKey} variant={isManuscript ? "caption" : "default"} /> : null}

      <ChatInput
        presentation={presentation}
        composerAnchorRef={composerAnchorRef}
        additionalDisabled={chatInputDisabled}
        fileUploadUrl={fileUploadUrl}
        registerPendingSendActions={registerPendingSendActions}
        registerGeneratedTextActions={registerGeneratedTextActions}
        onSessionChange={onSessionChange}
      />
    </div>
    </ChatUiControllerProvider>
  );
}
