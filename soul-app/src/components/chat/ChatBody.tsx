import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Platform,
  LayoutAnimation,
  UIManager,
  type FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type LayoutChangeEvent,
} from 'react-native';
import {
  useChatStore,
  createOptimisticUserEvent,
} from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import { createApiClient } from '../../api/client';
import type { SessionEvent } from '../../api/types';
import type { ChatRenderItem } from './groupChatEvents';
import { makeStyles } from './ChatBody.styles';
import { useChatHistoryPagination } from './useChatHistoryPagination';
import { PERSISTENT_HISTORY_EVENT_TYPES } from '../../api/persistentHistoryEventTypes';
import { useChatBottomFollow } from './useChatBottomFollow';
import { useTokens } from '../../theme';
import { ChatEventList } from './ChatEventList';
import { ClaudeRuntimeTasksStrip } from './ClaudeRuntimeTasksStrip';
import { ClaudeRuntimeSchedulesStrip } from './ClaudeRuntimeSchedulesStrip';
import { ClaudeRuntimeSignalsStrip } from './ClaudeRuntimeSignalsStrip';
import { useChatRenderItems } from './useChatRenderItems';
import { useChatSseStream } from './useChatSseStream';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';
import { AppKeyboardAvoidingView } from '../AppKeyboardAvoidingView';
import { persistentChatDisplaySettings } from '../settings/persistentSessionSettingsActions';
import { renderItemContainsEventId } from './chatSearchAnchor';
import { SessionStoryPanel } from './SessionStoryPanel';
import { useAppForegroundLifecycle } from '../../hooks/useAppForegroundLifecycle';
import { ChatInputComposer, type ChatInputComposerHandle } from './ChatInputComposer';
import { useEnsureSessionCached } from '../../hooks/useEnsureSessionCached';

interface Props {
  /** 표시할 세션 ID. undefined면 빈 상태 패널을 그린다. */
  sessionId: string | undefined;
  /** 실제 화면에 표시되는 동안만 상세 REST/SSE를 연다. mount된 UI state는 보존한다. */
  active?: boolean;
  /** inputRow가 보장할 최소 paddingBottom. iPad 패널 내부 home-indicator 보호에 사용한다. */
  minimumBottomPadding?: number;
  /** Task Tree row navigation anchor. */
  focusEventId?: number | null;
  /** 검색 결과에서 기존 세션 스토리 패널을 펼치는 일회성 요청. */
  storyOpenRequestId?: number | null;
  onFocusEventHandled?: (sessionId: string, eventId: number) => void;
  onStoryOpenRequestHandled?: () => void;
  /** 같은 채팅 부품을 원고형으로 표시한다. 기본 채팅은 기존 모양을 유지한다. */
  presentation?: 'default' | 'manuscript';
  /** 입력 줄과 대기 첨부를 감싼 묶음의 ChatBody 기준 배치. */
  onComposerLayout?: (event: LayoutChangeEvent) => void;
}

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const EMPTY_EVENTS: SessionEvent[] = [];

/**
 * 채팅 본문 — 메시지 리스트 + 입력창 + 첨부.
 *
 * react-navigation 의존 없음 (헤더 설정은 부모가 담당).
 * - 폰: ChatScreen이 useLayoutEffect로 nav 헤더 설정 후 ChatBody 본문만 렌더.
 * - 태블릿: ChatPane이 자체 인라인 헤더를 그린 뒤 ChatBody 본문만 렌더.
 *
 * 책임 구조 (refactor 260509.02):
 * - history pagination(F-A·F-B·F-D·F-H 가드 포함) → useChatHistoryPagination 훅
 * - 송신 흐름 → useChatSendFlow 훅
 * - 첨부 → useChatAttachments 훅
 * - SSE 머지 게이트 → sseGate.handleSessionSseEvent
 * - ChatBody는 lifecycle hub(첫 prompt + viewport reset + SSE 큐 reset),
 *   useSSEStream 배선, JSX(키보드 회피 + FlatList + 입력창)에 집중.
 */
export function ChatBody({
  sessionId,
  active = true,
  minimumBottomPadding = 0,
  focusEventId = null,
  storyOpenRequestId = null,
  onFocusEventHandled,
  onStoryOpenRequestHandled,
  presentation = 'default',
  onComposerLayout,
}: Props) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);

  const serverUrl = useSettingsStore((s) => s.serverUrl);
  const scopeGeneration = useAuthScopeGeneration();
  const authScope = useMemo(() => captureAuthScope(), [scopeGeneration]);
  // lastEventIdBySession은 의도적으로 구독하지 않는다 — urlBuilder가 매 connect 시
  // useChatStore.getState()로 최신값을 직접 읽으므로 변경마다 SSE를 재연결할 필요가 없다.
  // 세션 전환은 connectionKey: sessionId로 따로 트리거한다.
  const events = useChatStore((s) =>
    sessionId ? s.eventsBySession[sessionId] ?? EMPTY_EVENTS : EMPTY_EVENTS,
  );
  const streamingSlots = useChatStore((s) =>
    sessionId ? s.streamingSlotsBySession[sessionId] : undefined,
  );
  // 슬롯 selector: 슬롯 set/clear 시 한 번만 발화하여 renderItems 갱신.
  const pendingOptimistic = useChatStore((s) =>
    sessionId ? s.pendingOptimisticBySession[sessionId] : undefined,
  );
  const mergeEvents = useChatStore((s) => s.mergeEvents);
  const setLastEventId = useChatStore((s) => s.setLastEventId);
  const setStreamingEvent = useChatStore((s) => s.setStreamingEvent);
  const replaceAssistantStreamingEvents = useChatStore(
    (s) => s.replaceAssistantStreamingEvents,
  );
  const finalizeStreamingEvent = useChatStore((s) => s.finalizeStreamingEvent);
  const clearStreamingEvent = useChatStore((s) => s.clearStreamingEvent);
  const clearStreamingEvents = useChatStore((s) => s.clearStreamingEvents);
  const clearSession = useChatStore((s) => s.clearSession);
  const persistentDisplaySettings = useChatStore((s) => s.persistentDisplaySettings);
  const beginPersistentDisplaySettingsLoad = useChatStore((s) => s.beginPersistentDisplaySettingsLoad);
  const finishPersistentDisplaySettingsLoad = useChatStore((s) => s.finishPersistentDisplaySettingsLoad);
  const clearPersistentDisplaySettings = useChatStore((s) => s.clearPersistentDisplaySettings);
  const applyClaudeRuntimeEvent = useChatStore((s) => s.applyClaudeRuntimeEvent);

  const session = useSessionStore((s) =>
    sessionId ? s.sessions[sessionId] : undefined,
  );
  const { agentSessionId, nodeId, agentName, agentPortraitUrl, displayName, userName, userPortraitUrl } = session ?? {};
  // Preview and timestamp updates do not change message presentation or actions.
  const messageSession = useMemo(() => agentSessionId === undefined ? undefined : {
    agentSessionId, nodeId, agentName, agentPortraitUrl, displayName: displayName ?? null, userName, userPortraitUrl,
  }, [agentSessionId, nodeId, agentName, agentPortraitUrl, displayName, userName, userPortraitUrl]);
  const [snapshotGeneration, setSnapshotGeneration] = useState(0);
  const [highlightedItemKey, setHighlightedItemKey] = useState<string | null>(
    null,
  );
  const focusRequestRef = useRef({
    sessionId,
    eventId: focusEventId,
    generation: 0,
  });
  if (
    focusRequestRef.current.sessionId !== sessionId
    || focusRequestRef.current.eventId !== focusEventId
  ) {
    focusRequestRef.current = {
      sessionId,
      eventId: focusEventId,
      generation: focusRequestRef.current.generation + 1,
    };
  }
  const appForeground = useAppForegroundLifecycle();
  const detailedNetworkActive = active && appForeground;
  const composerRef = useRef<ChatInputComposerHandle>(null);
  const handleRetryPending = useCallback((eventId: string) => composerRef.current?.retryPending(eventId), []);
  const handleRestorePending = useCallback((eventId: string) => composerRef.current?.restorePending(eventId), []);

  // FlatList ref — history pagination과 bottom follow가 같은 viewport를 제어한다.
  const flatListRef = useRef<FlatList<ChatRenderItem>>(null);
  // SSE 재연결 후 history_sync 도착 전(catchup 구간) 여부. 초기값 true: 첫 연결도
  // catchup으로 시작한다(빈 catchup이면 history_sync가 즉시 도착해 false로 전환).
  const isCatchingUpRef = useRef(true);
  // F-B: historyLoadingRef=true 동안 도착한 라이브 SSE를 적재하는 큐 — sseGate.ts 정본.
  // history 훅의 loadHistoryPage finally 블록의 flushQueuedSseEvents가 일괄 머지하여
  // mergeEvents 동시 layout pass race를 차단한다.
  const pendingLiveQueueRef = useRef<Array<{ event: SessionEvent; eid: string }>>([]);
  const pendingCatchupQueueRef = useRef<Array<{ event: SessionEvent; eid: string }>>([]);
  const detailStreamFailureRef = useRef<(error: unknown) => void>(
    () => undefined,
  );
  const pendingSnapshotBaselineRef = useRef<{
    sessionId: string;
    cursor: string | null;
    commitRecovery: () => boolean;
  } | null>(null);

  const api = useMemo(
    () => (serverUrl ? createApiClient(serverUrl, { authScope }) : null),
    [authScope, serverUrl]
  );

  const displaySettingsSessionRef = useRef(sessionId);
  useEffect(() => {
    const previousSessionId = displaySettingsSessionRef.current;
    if (previousSessionId !== sessionId) clearPersistentDisplaySettings(previousSessionId);
    displaySettingsSessionRef.current = sessionId;
    if (!sessionId || !api) clearPersistentDisplaySettings(sessionId);
  }, [api, clearPersistentDisplaySettings, sessionId]);

  useEffect(() => {
    if (!sessionId || !api) {
      clearPersistentDisplaySettings(sessionId);
      return;
    }
    if (!detailedNetworkActive) return;
    let active = true;
    const requestId = beginPersistentDisplaySettingsLoad(sessionId);
    void api.getPersistentSession(sessionId).then(({ session: persistentSession }) => {
      if (!active) return;
      const settings = persistentSession.persistent ? persistentChatDisplaySettings(persistentSession) : null;
      finishPersistentDisplaySettingsLoad(sessionId, requestId, settings);
    }).catch(() => {
      if (active) finishPersistentDisplaySettingsLoad(sessionId, requestId, null);
    });
    return () => { active = false; };
  }, [api, beginPersistentDisplaySettingsLoad, clearPersistentDisplaySettings, detailedNetworkActive, finishPersistentDisplaySettingsLoad, sessionId]);
  useEnsureSessionCached(api, sessionId);

  const commitPendingSnapshotBaseline = useCallback(
    (committedSessionId: string) => {
      const pending = pendingSnapshotBaselineRef.current;
      if (!pending || pending.sessionId !== committedSessionId) return;
      try {
        if (!pending.commitRecovery()) {
          pendingSnapshotBaselineRef.current = null;
          return;
        }
        if (pending.cursor) {
          setLastEventId(committedSessionId, pending.cursor);
        }
        pendingSnapshotBaselineRef.current = null;
      } catch (error) {
        pendingSnapshotBaselineRef.current = null;
        detailStreamFailureRef.current(error);
      }
    },
    [setLastEventId],
  );
  const failDetailStream = useCallback((error: unknown) => {
    detailStreamFailureRef.current(error);
  }, []);

  // history pagination 책임을 훅에 위임 (F-A·F-B·F-D·F-H 가드 포함).
  // 본 훅의 useEffect[sessionId, api, authScope]는 본 컴포넌트의 useEffect보다 *먼저* 발화한다
  // (훅 등록이 컴포넌트 effect 등록보다 앞서기 때문). 기존 events는 유지하고 fetch 응답은
  // mergeEvents dedup/정렬에 맡겨 세션 재진입 blank frame을 만들지 않는다.
  const {
    historyLoading,
    reachedTop,
    mvcpEnabled,
    hasFetchError,
    retryFromError,
    requestOlder,
    onScroll,
    historyLoadingRef,
  } = useChatHistoryPagination({
    api,
    sessionId,
    ...(presentation === 'manuscript'
      ? { timelineEventTypes: PERSISTENT_HISTORY_EVENT_TYPES }
      : {}),
    snapshotGeneration,
    active: detailedNetworkActive,
    authScope,
    mergeEvents,
    setLastEventId,
    flatListRef,
    pendingLiveQueueRef,
    isCatchingUpRef,
    triggerAnimation: () =>
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut),
    applyStateOnlyEvent: applyClaudeRuntimeEvent,
    onInitialPageCommitted: commitPendingSnapshotBaseline,
    onAsyncCommitError: failDetailStream,
  });

  const resetToSnapshot = useCallback((
    baselineCursor: string | null,
    commitRecovery: () => boolean,
  ) => {
    if (!sessionId) return;
    historyLoadingRef.current = true;
    pendingLiveQueueRef.current = [];
    pendingCatchupQueueRef.current = [];
    pendingSnapshotBaselineRef.current = {
      sessionId,
      cursor: baselineCursor,
      commitRecovery,
    };
    clearSession(sessionId);
    setSnapshotGeneration((generation) => generation + 1);
  }, [clearSession, historyLoadingRef, sessionId]);

  // 세션 변경/마운트 시 lifecycle hub: 첫 prompt 처리 + viewport·input·attachment·SSE 큐 reset.
  // history pagination reset(historyCursor·reachedTop·mvcpEnabled·frontier·retry 등)은
  // useChatHistoryPagination 내부 effect[sessionId, api, authScope]가 처리한다.
  useEffect(() => {
    if (!sessionId) return;
    // 새 세션 진입이라면 NewSessionSheet가 보관해 둔 첫 prompt를 optimistic으로 머지.
    // (기존 세션 진입이면 pending이 비어 있어 no-op)
    // 빈 문자열은 호출자(NewSessionSheet)가 prompt.trim().length > 0 가드로 차단하므로
    // 여기서는 truthy 체크로 충분 (방어적 가드).
    // 시나리오 B(SSE 선도착) 처리는 mergeEvents가 가드하므로 여기서는 무조건 호출.
    const pendingText = useChatStore
      .getState()
      .consumePendingFirstMessage(sessionId);
    if (pendingText) {
      useChatStore
        .getState()
        .setPendingOptimistic(
          sessionId,
          createOptimisticUserEvent(pendingText, 'user_message'),
        );
    }
    // F-B: 세션 전환 시 이전 세션의 큐가 새 세션 mergeEvents에 오염되는 것을 차단한다.
    // 시나리오: 세션 A historyLoading=true 도중 세션 B로 전환 → A의 라이브 SSE가 큐 적재
    // → A finally가 flushQueuedSseEvents 호출 시 sessionId는 이미 B → mergeEvents(B, A의 events) 오염.
    // 새 세션 진입 시점에 ref를 비워 같은 ChatBody 인스턴스 안의 cross-session 누수를 차단.
    pendingLiveQueueRef.current = [];
    pendingCatchupQueueRef.current = [];
    pendingSnapshotBaselineRef.current = null;
    clearStreamingEvents(sessionId);
    // sendError 리셋은 useChatSendFlow가 sessionId 변경 시 자동 처리한다 (정본 이동에 따른 책임 이동).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, api]);

  useEffect(() => {
    return () => {
      if (sessionId) clearStreamingEvents(sessionId);
    };
  }, [sessionId, clearStreamingEvents]);

  useChatSseStream({
    api,
    sessionId,
    active: detailedNetworkActive,
    scopeGeneration,
    isCatchingUpRef,
    historyLoadingRef,
    pendingLiveQueueRef,
    pendingCatchupQueueRef,
    resetToSnapshot,
    mergeEvents,
    setLastEventId,
    setStreamingEvent,
    replaceAssistantStreamingEvents,
    clearStreamingEvent,
    finalizeStreamingEvent,
    applyClaudeRuntimeEvent,
    streamFailureRef: detailStreamFailureRef,
  });

  const displaySettings = persistentDisplaySettings && persistentDisplaySettings.sessionId === sessionId
    ? persistentDisplaySettings.settings
    : undefined;
  const { reversedItems, bottomFollowItemKey } = useChatRenderItems({
    events,
    pendingOptimistic,
    streamingSlots,
    sessionStatus: session?.status,
    persistentDisplaySettings: displaySettings ? {
      showGenerationSeparator: displaySettings.show_generation_separator,
      showJevCandidates: displaySettings.show_jev_candidates,
    } : undefined,
    presentation,
    showTurnUsage: displaySettings?.show_turn_usage !== false,
  });
  const focusEventIndex = focusEventId == null
    ? -1
    : reversedItems.findIndex((item) =>
        renderItemContainsEventId(item, focusEventId),
      );

  const {
    requestBottomFollow,
    suspendBottomFollow,
    onScrollBeginDrag,
    onScrollOffsetChange,
    onContentSizeChange,
  } = useChatBottomFollow({
    flatListRef,
    sessionId,
    bottomItemKey: bottomFollowItemKey,
  });

  useEffect(() => {
    if (
      !sessionId
      || focusEventId == null
      || focusEventIndex >= 0
      || !detailedNetworkActive
      || historyLoading
      || reachedTop
      || hasFetchError
    ) return;
    // 검색 결과를 여는 것은 명시적인 과거 탐색이다. 이전 페이지를 한 장씩
    // 불러오고, 네트워크 오류는 기존 재시도 UI에 맡긴다.
    requestOlder();
  }, [
    detailedNetworkActive,
    focusEventId,
    focusEventIndex,
    hasFetchError,
    historyLoading,
    reachedTop,
    reversedItems,
    requestOlder,
    sessionId,
  ]);

  useEffect(() => {
    if (!sessionId || focusEventId == null) return;
    const index = focusEventIndex;
    if (index < 0) return;
    const itemKey = reversedItems[index].key;
    const requestGeneration = focusRequestRef.current.generation;
    setHighlightedItemKey(itemKey);
    suspendBottomFollow();
    const frame = requestAnimationFrame(() => {
      const currentRequest = focusRequestRef.current;
      if (
        currentRequest.generation !== requestGeneration
        || currentRequest.sessionId !== sessionId
        || currentRequest.eventId !== focusEventId
      ) return;
      flatListRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: 0.5,
      });
      onFocusEventHandled?.(sessionId, focusEventId);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    focusEventId,
    focusEventIndex,
    onFocusEventHandled,
    reversedItems,
    sessionId,
    suspendBottomFollow,
  ]);

  useEffect(() => {
    if (!highlightedItemKey) return;
    const clearHighlight = setTimeout(
      () => setHighlightedItemKey(null),
      2200,
    );
    return () => clearTimeout(clearHighlight);
  }, [highlightedItemKey]);

  const handleListScroll = useCallback((
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ) => {
    onScrollOffsetChange(event.nativeEvent.contentOffset.y);
    onScroll(event);
  }, [onScroll, onScrollOffsetChange]);

  const handleScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    flatListRef.current?.scrollToOffset({
      offset: Math.max(0, info.averageItemLength * info.index), animated: true,
    });
  }, []);

  if (!sessionId) {
    return (
      <View style={[styles.container, styles.emptyState]}>
        <Text style={styles.emptyIcon}>💬</Text>
        <Text style={styles.emptyTitle}>채팅 없음</Text>
        <Text style={styles.emptyDesc}>
          왼쪽에서{"\n"}세션을 선택해주세요
        </Text>
      </View>
    );
  }

  return (
    <AppKeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SessionStoryPanel
        presentation={presentation}
        sessionId={sessionId}
        api={api}
        openRequestId={storyOpenRequestId}
        onOpenRequestHandled={onStoryOpenRequestHandled}
      />

      {focusEventId != null && reachedTop && focusEventIndex < 0 ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          검색 결과 이벤트를 대화에서 찾을 수 없습니다.
        </Text>
      ) : null}

      <ChatEventList
        flatListRef={flatListRef}
        items={reversedItems}
        onRetryPending={handleRetryPending}
        onRestorePending={handleRestorePending}
        session={messageSession}
        sessionId={sessionId}
        api={api}
        styles={styles}
        accentColor={t.colors.accent}
        requestOlder={requestOlder}
        onScroll={handleListScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        historyLoading={historyLoading}
        reachedTop={reachedTop}
        hasFetchError={hasFetchError}
        retryFromError={retryFromError}
        mvcpEnabled={mvcpEnabled}
        highlightedItemKey={highlightedItemKey}
        onContentSizeChange={onContentSizeChange}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        presentation={presentation}
      />

      <ClaudeRuntimeTasksStrip sessionId={sessionId} api={api} presentation={presentation} />
      <ClaudeRuntimeSchedulesStrip sessionId={sessionId} api={api} presentation={presentation} />
      <ClaudeRuntimeSignalsStrip sessionId={sessionId} api={api} presentation={presentation} />

      <ChatInputComposer
        key={sessionId}
        ref={composerRef}
        sessionId={sessionId}
        sessionStatus={session?.status}
        nodeId={nodeId}
        backend={session?.backend}
        api={api}
        detailedNetworkActive={detailedNetworkActive}
        appForeground={appForeground}
        minimumBottomPadding={minimumBottomPadding}
        requestBottomFollow={requestBottomFollow}
        presentation={presentation}
        onComposerLayout={onComposerLayout}
      />
    </AppKeyboardAvoidingView>
  );
}
