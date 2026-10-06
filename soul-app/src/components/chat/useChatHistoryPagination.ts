// 채팅 timeline REST pagination의 단일 경계. viewport clamp, 1회 retry,
// history/SSE 직렬화, 화면 활성화와 request owner 수명을 함께 관리한다.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { flushQueuedSseEvents, isStateOnlySseEventType } from './sseGate';
import { clampScrollIfNeeded } from './scrollClamp';
import { decideAutoSupplement } from './autoSupplement';
import type { ChatRenderItem } from './groupChatEvents';
import { toSessionEvent } from './groupChatEvents';
import type { SessionEvent } from '../../api/types';
import type { MessagesResponse } from '../../api/client';
import {
  isAuthScopeCurrent,
  type AuthScopeSnapshot,
} from '../../lib/auth-scope';

// 한 번에 가져올 메시지 페이지 크기. 화면 분량 대비 부족하면 사용자 스크롤 시
// 보충 로딩이 시각적으로 노출되므로 1.5~2 화면 분량을 목표로 한다.
const HISTORY_PAGE_SIZE = 100;

export interface UseChatHistoryPaginationDeps {
  /** API 클라이언트 (없으면 fetch 발사 안 함). */
  api: { getTimeline: (sid: string, params: { limit: number; before: string | undefined; signal?: AbortSignal; eventTypes?: string[] }) => Promise<MessagesResponse> } | null;
  /** PAS 원고형만 서버 semantic timeline 타입과 complete를 명시한다. */
  timelineEventTypes?: readonly string[];
  /** 표시할 세션 ID. undefined면 fetch 발사 안 함. */
  sessionId: string | undefined;
  /** 같은 세션에서 서버가 스냅샷 재로드를 지시할 때 증가하는 generation. */
  snapshotGeneration: number;
  /** 실제 화면 표시 + foreground가 모두 충족될 때만 REST lifecycle을 연다. */
  active: boolean;
  /** 고정 API 클라이언트와 같은 opaque auth scope. */
  authScope: AuthScopeSnapshot;
  /** chatStore.mergeEvents — 본 훅은 store 모르고 어댑터로만 호출. */
  mergeEvents: (sessionId: string, events: SessionEvent[]) => void;
  /** chatStore.setLastEventId — 같은 이유로 어댑터. */
  setLastEventId: (sessionId: string, id: string) => void;
  /** FlatList ref — 첫 페이지 응답 시 scrollToOffset(0) + onScroll clamp 시 사용. */
  flatListRef: React.RefObject<FlatList<ChatRenderItem> | null>;
  /**
   * F-B 큐 — historyLoading 중 라이브 SSE를 적재. 본 훅의 loadHistoryPage finally에서
   * flushQueuedSseEvents로 batch 머지. ref 소유자는 ChatBody (cross-session 비우기 책임).
   */
  pendingLiveQueueRef: { current: Array<{ event: SessionEvent; eid: string }> };
  /** F-B catchup 단계 판정 — flushQueuedSseEvents가 triggerAnimation을 발화할지 결정. */
  isCatchingUpRef: { current: boolean };
  /** LayoutAnimation 발화 어댑터 — flushQueuedSseEvents 라이브 단계에서 1회 호출. */
  triggerAnimation: () => void;
  /** Runtime/hook/mode history 이벤트는 채팅 타임라인 대신 상태 store에만 적용한다. */
  applyStateOnlyEvent?: (sessionId: string, type: string, data: unknown) => void;
  /** 첫 페이지가 store에 반영된 뒤 snapshot boundary cursor를 확정하기 위한 callback. */
  onInitialPageCommitted?: (sessionId: string) => void;
  onAsyncCommitError?: (error: unknown) => void;
}

export interface UseChatHistoryPaginationResult {
  /** REST 페이지 로딩 중. */
  historyLoading: boolean;
  /** next_cursor가 null로 도착해 더 이상 prepend할 이력이 없음. */
  reachedTop: boolean;
  /** 첫 페이지 응답 뒤 maintainVisibleContentPosition을 활성화한다. */
  mvcpEnabled: boolean;
  /** onEndReached에서 다음 페이지를 요청한다. */
  requestOlder: () => void;
  /** 현재 offset 기록과 fetch frontier clamp를 수행한다. */
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** SSE 게이트가 같은 tick의 최신 loading 상태를 읽는 동기 ref. */
  historyLoadingRef: { current: boolean };
  /** 자동 retry 1회까지 실패해 사용자 재시도가 필요한 상태. */
  hasFetchError: boolean;
  /** 현재 cursor에서 사용자 수동 재시도를 시작한다. */
  retryFromError: () => void;
}

export function useChatHistoryPagination(
  deps: UseChatHistoryPaginationDeps,
): UseChatHistoryPaginationResult {
  const {
    api,
    sessionId,
    snapshotGeneration,
    active,
    authScope,
    mergeEvents,
    setLastEventId,
    flatListRef,
    pendingLiveQueueRef,
    isCatchingUpRef,
    triggerAnimation,
    applyStateOnlyEvent,
    onInitialPageCommitted,
    onAsyncCommitError,
    timelineEventTypes,
  } = deps;

  const [historyCursor, setHistoryCursor] = useState<string | null | undefined>(
    undefined,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const [mvcpEnabled, setMvcpEnabled] = useState(false);
  // F-H-2 보강: 자동 retry 1회 후에도 실패한 영구 실패 상태 — ChatBody가 ListFooterComponent에
  // HistoryFetchError(에러 + 재시도 버튼)를 표시할지 결정하는 신호. 자연 재시도 경로 성공 시
  // try success branch가 자동으로 false로 reset.
  const [hasFetchError, setHasFetchError] = useState(false);

  const historyLoadingRef = useRef(false);
  // Detect a cursor cycle within this session/auth/snapshot owner. Comparing only with the
  // immediately previous cursor misses A → B → A and can trap search-event auto-pagination.
  const issuedHistoryCursorsRef = useRef(new Set<string>());
  const autoSupplementedRef = useRef(false);
  // F-H-1: onScroll 마다 contentOffset.y를 적재하는 측정 cache (정본 X — 정본은 fetchFrontierRef).
  const lastScrollOffsetRef = useRef(0);
  // F-H-1: fetch in-flight 시 사용자 viewport의 위쪽 한계.
  const fetchFrontierRef = useRef<number | null>(null);
  // F-H-2: fetch 실패 시 자동 retry 1회 카운터.
  const retryCountRef = useRef(0);
  // F-H-2: retry timeout id — 세션 전환 시 clearTimeout으로 cross-session 차단.
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 첫 페이지 응답 뒤 initial scroll을 예약한 animation frame. owner 교체/unmount 시
  // 취소하지 않으면 guard가 state write를 막더라도 RN Jest wrapper의 jest.now()가
  // environment teardown 뒤 실행될 수 있고, 실제 앱에서도 닫힌 화면의 callback이 남는다.
  const initialScrollFrameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const sessionGenerationRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const initialPageCommittedRef = useRef(false);
  const ownerKey = `${authScope.generation}\u0000${sessionId ?? ''}`;
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  const activeRequestRef = useRef<{
    generation: number;
    authScope: AuthScopeSnapshot;
    sessionId: string;
    controller: AbortController | null;
    before: string | undefined;
  } | null>(null);

  const isCurrentRequest = (
    generation: number,
    requestAuthScope: AuthScopeSnapshot,
    requestSessionId: string,
    controller: AbortController | null,
  ): boolean => {
    const active = activeRequestRef.current;
    return (
      active?.generation === generation &&
      active.authScope === requestAuthScope &&
      authScope === requestAuthScope &&
      isAuthScopeCurrent(requestAuthScope) &&
      active.sessionId === requestSessionId &&
      active.controller === controller &&
      controller?.signal.aborted !== true
      && activeRef.current
    );
  };

  const loadHistoryPage = useCallback(
    async (before?: string) => {
      if (!api || !sessionId || !activeRef.current) return;
      if (!isAuthScopeCurrent(authScope)) return;
      if (historyLoadingRef.current) return;
      const requestSessionId = sessionId;
      // ChatBody가 고정 API client를 만들 때 사용한 동일 snapshot을 요청 owner로
      // 캡처한다. 여기서 전역 scope를 다시 capture하면 cleanup 전 A→B 경합에서
      // A client와 B owner가 잘못 결합되므로 반드시 전달받은 snapshot을 사용한다.
      const requestAuthScope = authScope;
      const requestOwnerKey = ownerKey;
      const requestGeneration = sessionGenerationRef.current;
      const controller =
        typeof AbortController === 'undefined' ? null : new AbortController();
      activeRequestRef.current = {
        generation: requestGeneration,
        authScope: requestAuthScope,
        sessionId: requestSessionId,
        controller,
        before,
      };
      historyLoadingRef.current = true;
      setHistoryLoading(true);
      try {
        const params: {
          limit: number;
          before: string | undefined;
          signal?: AbortSignal;
          eventTypes?: string[];
        } = {
          limit: HISTORY_PAGE_SIZE,
          before,
          signal: controller?.signal,
        };
        if (timelineEventTypes !== undefined) {
          params.eventTypes = [...timelineEventTypes];
        }
        const res = await api.getTimeline(requestSessionId, params);
        if (!isCurrentRequest(requestGeneration, requestAuthScope, requestSessionId, controller)) {
          return;
        }
        const cursorDidNotAdvance = before !== undefined && res.next_cursor === before;
        const cursorWasAlreadyIssued = res.next_cursor !== null
          && issuedHistoryCursorsRef.current.has(res.next_cursor);
        const emptyPageClaimsMore = res.messages.length === 0 && res.next_cursor !== null;
        if (cursorDidNotAdvance || cursorWasAlreadyIssued || emptyPageClaimsMore) {
          console.warn('[useChatHistoryPagination] invalid history cursor response:', {
            before,
            nextCursor: res.next_cursor,
            cursorWasAlreadyIssued,
            messageCount: res.messages.length,
          });
          setHasFetchError(true);
          return;
        }
        if (res.next_cursor !== null) {
          issuedHistoryCursorsRef.current.add(res.next_cursor);
        }
        const ascMessages = [...res.messages].reverse();
        const sessionEvents: SessionEvent[] = [];
        for (const message of ascMessages) {
          if (isStateOnlySseEventType(message.event_type)) {
            applyStateOnlyEvent?.(requestSessionId, message.event_type, message.payload);
            continue;
          }
          sessionEvents.push(toSessionEvent(message));
        }
        if (sessionEvents.length > 0) {
          mergeEvents(requestSessionId, sessionEvents);
        }
        if (before === undefined && ascMessages.length > 0) {
          const newest = ascMessages[ascMessages.length - 1];
          setLastEventId(requestSessionId, String(newest.id));
        }
        if (before === undefined) {
          initialPageCommittedRef.current = true;
          onInitialPageCommitted?.(requestSessionId);
        }

        setHistoryCursor(res.next_cursor);
        if (res.next_cursor === null) setReachedTop(true);
        // F-H-2: 성공 시 retry 카운터 reset — 다음 prepend 호출에서 다시 1회 retry 권한 부여.
        retryCountRef.current = 0;
        // F-H-2 보강: 성공 시 ErrorBox 자동 해제 — ErrorBox 표시 중에 자연 재시도 경로
        // (onEndReached / SSE 도착)가 성공하면 박스가 자연스럽게 사라진다 (사용자에게
        // "수동 재시도 안 해도 됐네" 인지). 사용자 수동 재시도 성공 시에도 동일.
        setHasFetchError(false);
        // 첫 페이지 응답 시점에만 viewport를 시각적 최하단(inverted offset=0)으로 정렬한다.
        // resume 진입(100건 이력 + status='running' 초기 렌더)에서 typing indicator가
        // autoscrollToTopThreshold 트리거 없이 viewport 안에 들어오게 하기 위한 보정.
        // prepend 페치(before !== undefined)에서는 maintainVisibleContentPosition이
        // viewport 좌표를 보존하므로 호출하지 않는다 — 호출하면 사용자가 보던 위치에서
        // 시각적 최하단으로 강제 점프하는 회귀 발생 (커밋 2f49bc8 회귀, 빌드 33).
        if (before === undefined) {
          if (initialScrollFrameRef.current !== null) {
            cancelAnimationFrame(initialScrollFrameRef.current);
          }
          initialScrollFrameRef.current = requestAnimationFrame(() => {
            initialScrollFrameRef.current = null;
            if (
              ownerKeyRef.current !== requestOwnerKey
              || controller?.signal.aborted
              || !isAuthScopeCurrent(requestAuthScope)
            ) return;
            flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
          });
        }
      } catch (err) {
        if (!isCurrentRequest(requestGeneration, requestAuthScope, requestSessionId, controller)) {
          return;
        }
        if (controller?.signal.aborted) {
          return;
        }
        console.warn('[useChatHistoryPagination] history fetch failed:', err);
        // F-H-2: 자동 retry 1회. RN FlatList의 onEndReached가 같은 viewport 위치에서
        // 재발화하지 않는 정책상, 사용자가 같은 자리에 머물면 영구 빈 공간이 노출되는
        // 결함을 차단. 1회 retry 후에도 실패하면 silent — 라이브 SSE 도착 또는 사용자
        // viewport 변경 시 자연 재시도가 가능하므로 무한 retry는 불필요(영구 에러 시
        // 무한 spinner + 배터리 소모 회피).
        //
        // 1초 지연 근거: 즉시 retry는 transient 네트워크 에러 시 같은 결과 반복 위험.
        // 1초는 사용자 인지 임계 안 + transient blip(503·네트워크 일시) 해소 임계 안.
        //
        // retry 경로는 requestOlder와 달리 frontier 미설정 — 의도적. retry 발화 시점에
        // historyLoadingRef=false (직전 finally) + frontier=null (직전 release) 상태이며,
        // retry는 "사용자 위치 무관하게 한 번 더 시도"의 의미라 frontier 없이 실행되는 것이
        // 자연스럽다 (analysis-cache §12.6).
        if (retryCountRef.current < 1) {
          retryCountRef.current += 1;
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            if (
              ownerKeyRef.current !== requestOwnerKey
              || !isAuthScopeCurrent(requestAuthScope)
            ) return;
            // sessionId closure는 retry 콜백이 만들어진 시점의 값이지만,
            // 세션 전환 시 useEffect[sessionId, api]가 clearTimeout으로 본 콜백을 취소하므로
            // 본 발화 시점의 sessionId는 항상 활성 세션 (cross-session 누수 차단).
            if (sessionId) loadHistoryPage(before);
          }, 1000);
        } else {
          // F-H-2 보강: 자동 retry(retryCountRef.current === 1) 후에도 실패하면 영구 실패로
          // 간주하고 사용자 인지 가능 표면(hasFetchError)으로 전환. silent fall-through
          // (console.warn만)을 명시화 — F-H-2 정책은 보존(자동 retry 1회), ErrorBox만 추가.
          // 사용자 수동 재시도(retryFromError) 또는 자연 재시도(onEndReached / SSE 도착) 시
          // try success branch가 setHasFetchError(false)로 자동 해제.
          setHasFetchError(true);
        }
      } finally {
        if (!isCurrentRequest(requestGeneration, requestAuthScope, requestSessionId, controller)) {
          return;
        }
        activeRequestRef.current = null;
        historyLoadingRef.current = false;
        setHistoryLoading(false);
        // F-H-1: fetch 응답 처리(성공 mergeEvents 또는 실패 catch) 직후 frontier 해제 —
        // 사용자가 새 events 위로 자유롭게 스크롤 가능. 실패 시에도 finally가 실행되므로
        // 자연 재시도(다시 onEndReached 트리거 또는 catch의 자동 retry)가 보장된다.
        fetchFrontierRef.current = null;
        // F-B: historyLoading=true 동안 큐잉된 라이브 SSE를 한 번의 mergeEvents로 batch flush.
        // sseGate 큐 정본은 sseGate.ts(flushQueuedSseEvents) — design-principles §3 정본 하나.
        // catch 진입(fetch 실패) 시에도 finally가 실행되므로 큐 누수 없음.
        if (requestSessionId) {
          const sid = requestSessionId;
          try {
            flushQueuedSseEvents(
              { pendingLiveQueueRef, isCatchingUpRef },
              {
                triggerAnimation,
                ingestEventsBatch: (events) => mergeEvents(sid, events),
                setLastEventId: (id) => setLastEventId(sid, id),
              },
            );
          } catch (error) {
            onAsyncCommitError?.(error);
          }
        }
      }
    },
    // ref·flatListRef·pendingLiveQueueRef·isCatchingUpRef·triggerAnimation은 안정 reference이므로
    // deps에 미포함 (sseGate 정본 패턴과 동일).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      api,
      sessionId,
      authScope,
      ownerKey,
      mergeEvents,
      setLastEventId,
      applyStateOnlyEvent,
      onInitialPageCommitted,
      onAsyncCommitError,
      timelineEventTypes,
    ],
  );
  const loadHistoryPageRef = useRef(loadHistoryPage);
  loadHistoryPageRef.current = loadHistoryPage;

  // 세션 변경/마운트 시: history state·ref reset + 첫 페이지 fetch.
  // ChatBody의 lifecycle hub useEffect[sessionId, api]는 별도로 발화하여 input·
  // attachment·SSE 큐 reset 등 다른 책임을 처리한다 (analysis §2.1 발화 순서).
  useEffect(() => {
    if (!sessionId) return;
    sessionGenerationRef.current += 1;
    activeRequestRef.current?.controller?.abort();
    activeRequestRef.current = null;
    if (initialScrollFrameRef.current !== null) {
      cancelAnimationFrame(initialScrollFrameRef.current);
      initialScrollFrameRef.current = null;
    }
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    setHistoryCursor(undefined);
    issuedHistoryCursorsRef.current.clear();
    setReachedTop(false);
    setMvcpEnabled(false);
    initialPageCommittedRef.current = false;
    autoSupplementedRef.current = false;
    // F-H-1·F-H-2: 세션 전환 시 frontier·retry ref도 cross-session 리셋.
    // - 시나리오 A: 세션 A onScroll로 lastScrollOffsetRef ~5000 → 세션 B 진입 → 첫 fetch 시
    //   frontier=5000(이전 세션 좌표) 의도하지 않게 set되어 새 세션이 그 위치에 묶이는 결함 차단.
    // - 시나리오 B: 세션 A retry 1초 대기 도중 세션 B 진입 → clearTimeout으로 retry 콜백 취소
    //   하여 cross-session 재시도 차단 (콜백의 sessionId closure는 A이지만 콜백이 발화 안 하므로 무해).
    lastScrollOffsetRef.current = 0;
    fetchFrontierRef.current = null;
    if (retryTimeoutRef.current !== null) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    retryCountRef.current = 0;
    // F-H-2 보강: 세션 전환 시 ErrorBox 영구 표시 차단. cross-session에서 이전 세션의
    // 에러 상태가 새 세션 fetch 흐름에 끼어드는 결함 방지 (4 ref 리셋과 같은 패턴).
    setHasFetchError(false);
    const generation = sessionGenerationRef.current;
    return () => {
      const active = activeRequestRef.current;
      if (active?.generation === generation) {
        active.controller?.abort();
        // 일부 RN/WebView runtime에는 AbortController가 없다. controller 유무와
        // 무관하게 owner를 폐기해야 unmount 뒤 늦은 응답이 current로 판정되지 않는다.
        activeRequestRef.current = null;
      }
      // unmount 또는 owner 교체 시 실패 재시도 타이머도 함께 폐기한다. 진행 중
      // request만 abort하고 retry timeout을 남기면 unmount 뒤 loadHistoryPage가 다시
      // 발화해 Jest teardown 경고뿐 아니라 닫힌 채팅의 불필요한 REST 요청도 만든다.
      if (retryTimeoutRef.current !== null) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (initialScrollFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollFrameRef.current);
        initialScrollFrameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, api, authScope, snapshotGeneration, timelineEventTypes]);

  // 화면 숨김/background는 owner를 버리지 않고 진행 중인 작업만 중단한다.
  // 완료된 첫 페이지·pagination cursor는 보존하여 재활성화가 중복 initial fetch를 만들지 않는다.
  useEffect(() => {
    if (!active) {
      sessionGenerationRef.current += 1;
      const currentRequest = activeRequestRef.current;
      currentRequest?.controller?.abort();
      if (currentRequest?.before !== undefined) {
        // 중단된 보충/prepend는 같은 cursor에서 다시 시도할 수 있어야 한다.
        autoSupplementedRef.current = false;
      }
      activeRequestRef.current = null;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      fetchFrontierRef.current = null;
      if (retryTimeoutRef.current !== null) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      if (initialScrollFrameRef.current !== null) {
        cancelAnimationFrame(initialScrollFrameRef.current);
        initialScrollFrameRef.current = null;
      }
      return;
    }
    if (!api || !sessionId || initialPageCommittedRef.current) return;
    loadHistoryPageRef.current(undefined);
  }, [active, api, sessionId, authScope, snapshotGeneration]);

  // 첫 페이지 응답 직후 1회 자동 보충 페치. RN FlatList는 같은 viewport에서
  // onEndReached를 자동 재발화하지 않으므로, 첫 페이지가 화면을 못 채우면
  // 사용자가 스크롤하기 전까지 추가 로드가 누락된다. 이를 우회하여 마운트
  // 시점에 한 화면 추가 분량(총 200건)을 미리 확보한다.
  useEffect(() => {
    if (!active) return;
    const next = decideAutoSupplement({
      alreadySupplemented: autoSupplementedRef.current,
      historyCursor,
      reachedTop,
    });
    if (next === null) return;
    autoSupplementedRef.current = true;
    // F-H-1: autoSupplement 경로는 사용자 트리거가 아닌 자동 fetch이므로 frontier *미설정*.
    // 발화 조건 자체가 첫 페이지 화면 미충족(decideAutoSupplement: 화면이 안 차서 사용자가
    // 스크롤하기 전까지 추가 로드가 누락되는 케이스) → 이 시점에 사용자가 위로 스크롤할
    // 충분한 콘텐츠가 없어 unloaded 영역 노출 위험이 낮다. frontier=0 강제는 ux-principles §1
    // 마찰 회피 측면에서 정공법 (analysis-cache §13).
    loadHistoryPage(next);
  }, [active, historyCursor, reachedTop, loadHistoryPage]);

  // 첫 페이지가 도착하여 historyCursor가 string|null로 확정되면 MVCP 활성화.
  // data=[]에서 native MVCP가 anchor를 0번에 고정하는 RN 0.81 회귀 자체를 우회.
  // 빈 세션(historyCursor=null)도 활성화하나 data=[]면 MVCP가 무의미하므로 영향 없음.
  useEffect(() => {
    if (historyCursor === undefined) return;
    setMvcpEnabled(true);
  }, [historyCursor]);

  const requestOlder = useCallback(() => {
    if (!activeRef.current) return;
    if (reachedTop) return;
    if (historyCursor === undefined || historyCursor === null) return;
    // F-H-1: fetch 발사 직전의 contentOffset.y를 frontier로 freeze.
    // 사용자 트리거 경로(=onEndReached → requestOlder)에 한정 — autoSupplement는 미설정.
    // historyLoadingRef.current가 true면 loadHistoryPage 안에서 즉시 silent return하지만,
    // 이 경로는 frontier가 이미 활성 상태(직전 fetch 진행 중)이므로 더 최근 lastScrollOffsetRef
    // 값으로 덮어쓰는 효과 — clamp가 더 엄격해질 뿐 결함 아님.
    fetchFrontierRef.current = lastScrollOffsetRef.current;
    loadHistoryPage(historyCursor);
  }, [reachedTop, historyCursor, loadHistoryPage]);

  // F-H-1: 사용자 viewport의 위쪽 한계(frontier) 강제. fetch in-flight 동안 사용자가
  // store에 없는 영역(spinner+빈 padding)으로 진입하지 못하도록 동기적으로 clamp.
  // - 매 scroll event마다 lastScrollOffsetRef 갱신 (requestOlder가 fetch 발사 시점에
  //   이 값을 frontier로 freeze).
  // - frontier가 활성(non-null)이고 currentOffset > frontier면 clampScrollIfNeeded가
  //   즉시 scrollToOffset(frontier, animated=false)로 되돌린다.
  // deps는 [] — flatListRef·ref들은 React가 안정 reference 보장, clampScrollIfNeeded는
  // pure import이므로 deps 불필요.
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = e.nativeEvent.contentOffset.y;
      lastScrollOffsetRef.current = offset;
      clampScrollIfNeeded(
        offset,
        fetchFrontierRef.current,
        (target) =>
          flatListRef.current?.scrollToOffset({
            offset: target,
            animated: false,
          }),
      );
    },
    // ref는 React가 안정 reference 보장.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ErrorBox 수동 재시도. string cursor면 prepend, 첫 페이지 미도착이면 initial이다.
  const retryFromError = useCallback(() => {
    setHasFetchError(false);
    retryCountRef.current = 0;
    const before =
      typeof historyCursor === 'string' ? historyCursor : undefined;
    loadHistoryPage(before);
  }, [historyCursor, loadHistoryPage]);

  return {
    historyLoading,
    reachedTop,
    mvcpEnabled,
    requestOlder,
    onScroll,
    historyLoadingRef,
    hasFetchError,
    retryFromError,
  };
}
