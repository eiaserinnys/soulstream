/**
 * ChatView 과거 메시지 buffer와 bounded viewport fill controller.
 *
 * timeline page는 라이브 SSE와 같은 event processor를 거쳐 store.tree에 합쳐진다.
 * 초기 진입, Virtuoso startReached, viewport geometry 재평가, 수동 재시도는 모두
 * requestOlder 하나로 시작되는 controller run을 사용한다. 페이지 수는 안전 상한일 뿐,
 * 자동 진행 여부는 공개 scroller DOM의 화면 분량으로만 결정한다.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { SoulSSEEvent } from "@shared/types";
import { useDashboardStore } from "../../stores/dashboard-store";
import { diag } from "../../lib/diag";
import { hasFilledHistoryViewport } from "./ChatView.viewport-geometry";

/** 초기 로드 / prepend 페이지 크기 (soul-app ChatBody.tsx:43과 동기화 — atom 88d8c640) */
export const HISTORY_PAGE_SIZE = 100;
/** 한 번의 자동/수동 fill run에서 성공적으로 받을 수 있는 최대 page 수. */
export const MAX_VIEWPORT_FILL_PAGES = 5;
/** 화면을 채운 뒤 reverse scroll을 바로 재개할 수 있게 남기는 여유. */
export const VIEWPORT_FILL_MARGIN_PX = 200;

/**
 * Chat transcript가 생성하거나 상태를 해소하는 timeline 타입만 요청한다.
 * thinking은 라이브 표시에는 쓰이지만 과거 transcript 복원에서는 제외한다.
 * 원문 payload가 큰 고빈도 thinking/context/realtime 행이 페이지·응답 byte 예산을
 * 잠식하지 않게 하는 것이 이 서버-side projection의 목적이다.
 */
export const CHAT_HISTORY_EVENT_TYPES = [
  "user_message",
  "intervention_sent",
  "session_notification",
  "assistant_message",
  "turn_summary",
  "tool_start",
  "tool_result",
  "error",
  "assistant_error",
  "system_message",
  "compact",
  "input_request",
  "input_request_expired",
  "input_request_responded",
  "tool_approval_requested",
  "tool_approval_resolved",
  "agent_updated",
  "handoff_requested",
  "handoff_occurred",
  "guardrail_tripwire",
  "away_summary",
] as const;

export type HistoryLoadBlockReason = "cap" | "error";
export type HistoryRequestSource = "automatic" | "manual";
export type HistoryPageOutcome =
  | "fetched"
  | "busy"
  | "reachedTop"
  | "failed"
  | "stale";

/** 서버 응답의 단일 메시지 (soul_common.db.session_db.read_timeline) */
export interface HistoricalMessage {
  id: number;
  parent_event_id: number | null;
  event_type: string;
  payload: Record<string, unknown>;
  /** ISO8601 timestamp */
  created_at: string;
}

interface TimelineResponse {
  messages: HistoricalMessage[];
  /** 다음 페이지 커서 (ISO timestamp). null이면 더 이상 과거 메시지 없음 */
  next_cursor: string | null;
}

interface FillRun {
  generation: HistoryGeneration;
  pagesFetched: number;
  awaitingCommit: boolean;
  source: HistoryRequestSource;
}

interface HistoryActivationTarget {
  token: symbol;
  sessionId: string | null;
  historyResetVersion: number;
  enabled: boolean;
}

interface HistoryGeneration {
  token: symbol;
  sessionId: string;
  historyResetVersion: number;
  ready: true;
}

interface HistoryRequestOwner {
  generation: HistoryGeneration;
  run: FillRun;
  abortController: AbortController;
}

export interface UseMessageHistoryBufferResult {
  loading: boolean;
  reachedTop: boolean;
  blockedReason: HistoryLoadBlockReason | null;
  /** startReached/자동 채움/수동 재시도의 단일 controller 진입점. */
  requestOlder: (source?: HistoryRequestSource) => void;
  /** scroller bind/items commit/list height 변경이 공유하는 geometry 재평가 경로. */
  notifyViewportGeometry: () => void;
}

/** timeline DB row를 renderer-compatible SSE event로 정규화한다. */
export function toSSEEvent(m: HistoricalMessage): { event: SoulSSEEvent; eventId: number } {
  const payload = m.payload as Record<string, unknown>;
  const event = {
    ...payload,
    type: m.event_type,
    ...(payload.parent_event_id != null ? { parent_event_id: String(payload.parent_event_id) } : {}),
    ...(payload.tool_use_id != null ? { tool_use_id: String(payload.tool_use_id) } : {}),
    ...(payload.request_id != null ? { request_id: String(payload.request_id) } : {}),
  } as SoulSSEEvent;
  return { event, eventId: m.id };
}

export function buildHistoryPageUrl(sessionId: string, before: string | null): string {
  const qs = new URLSearchParams({
    limit: String(HISTORY_PAGE_SIZE),
    event_types: CHAT_HISTORY_EVENT_TYPES.join(","),
  });
  if (before !== null) qs.set("before", before);
  return `/api/sessions/${encodeURIComponent(sessionId)}/timeline?${qs}`;
}

async function fetchHistoryPage(
  sessionId: string,
  before: string | null,
  signal: AbortSignal,
): Promise<TimelineResponse> {
  const response = await fetch(buildHistoryPageUrl(sessionId, before), {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw new Error(`timeline request failed: ${response.status}`);
  }
  return (await response.json()) as TimelineResponse;
}

export function useMessageHistoryBuffer(
  sessionId: string | null,
  scrollerRef: RefObject<HTMLElement | null>,
  enabled = true,
): UseMessageHistoryBufferResult {
  const historyResetVersion = useDashboardStore((state) => state.historyResetVersion);
  const [loading, setLoading] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const [blockedReason, setBlockedReason] =
    useState<HistoryLoadBlockReason | null>(null);

  // activeRequestRef가 in-flight의 유일한 동기 정본이다. state는 표시용 projection이다.
  const reachedTopRef = useRef(false);
  const blockedReasonRef = useRef<HistoryLoadBlockReason | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const initialPageLoadedRef = useRef(false);
  const activeGenerationRef = useRef<HistoryGeneration | null>(null);
  const configuredHistoryRef = useRef<{
    sessionId: string;
    historyResetVersion: number;
  } | null>(null);
  const fillRunRef = useRef<FillRun | null>(null);
  const activeRequestRef = useRef<HistoryRequestOwner | null>(null);

  // render 중에는 candidate만 만든다. committed layout effect만 ready generation을 공개한다.
  const activationTarget = useMemo<HistoryActivationTarget>(() => ({
    token: Symbol("history activation"),
    sessionId,
    historyResetVersion,
    enabled,
  }), [enabled, historyResetVersion, sessionId]);

  const isActiveGeneration = useCallback((generation: HistoryGeneration): boolean => {
    const store = useDashboardStore.getState();
    return generation.ready
      && activeGenerationRef.current === generation
      && store.activeSessionKey === generation.sessionId
      && store.historyResetVersion === generation.historyResetVersion;
  }, []);

  const resolveCommittedGeneration = useCallback((
    target: HistoryActivationTarget,
  ): HistoryGeneration | null => {
    const generation = activeGenerationRef.current;
    if (
      !target.enabled
      || target.sessionId === null
      || generation === null
      || !generation.ready
      || generation.token !== target.token
      || generation.sessionId !== target.sessionId
      || generation.historyResetVersion !== target.historyResetVersion
      || !isActiveGeneration(generation)
    ) return null;
    return generation;
  }, [isActiveGeneration]);

  const updateReachedTop = useCallback((value: boolean) => {
    reachedTopRef.current = value;
    setReachedTop(value);
  }, []);

  const updateBlockedReason = useCallback((value: HistoryLoadBlockReason | null) => {
    blockedReasonRef.current = value;
    setBlockedReason(value);
  }, []);

  const requestHistoryPage = useCallback(async (
    run: FillRun,
  ): Promise<HistoryPageOutcome> => {
    const { generation } = run;
    if (!isActiveGeneration(generation)) return "stale";
    if (activeRequestRef.current !== null) return "busy";
    if (reachedTopRef.current) return "reachedTop";

    const before = initialPageLoadedRef.current ? nextCursorRef.current : null;
    if (initialPageLoadedRef.current && before === null) return "reachedTop";

    const abortController = new AbortController();
    const requestOwner: HistoryRequestOwner = {
      generation,
      run,
      abortController,
    };
    activeRequestRef.current = requestOwner;
    setLoading(true);
    try {
      const data = await fetchHistoryPage(
        generation.sessionId,
        before,
        abortController.signal,
      );
      if (!isActiveGeneration(generation)) return "stale";

      const messages = Array.isArray(data.messages) ? data.messages : [];
      const nextCursor = data.next_cursor ?? null;
      const cursorDidNotAdvance = before !== null && nextCursor === before;
      const emptyPageClaimsMore = messages.length === 0 && nextCursor !== null;
      if (cursorDidNotAdvance || emptyPageClaimsMore) {
        fillRunRef.current = null;
        updateBlockedReason("error");
        return "failed";
      }

      // fetch와 store 반영 사이에도 session이 바뀔 수 있으므로 경계 직전 재검증한다.
      if (!isActiveGeneration(generation)) return "stale";
      const events = [...messages].reverse().map(toSSEEvent);
      // store update가 만든 React commit부터 geometry 신호를 받을 준비를 끝낸다.
      run.awaitingCommit = true;
      const { addedCount } = useDashboardStore.getState().processHistoryEvents(events);
      if (!isActiveGeneration(generation)) return "stale";

      initialPageLoadedRef.current = true;
      nextCursorRef.current = nextCursor;
      run.pagesFetched += 1;
      if (run.source === "manual") updateBlockedReason(null);

      diag("history", "viewport fill page", {
        sessionId: generation.sessionId,
        before,
        received: messages.length,
        addedCount,
        pagesFetched: run.pagesFetched,
        nextCursor,
      });

      if (nextCursor === null) {
        fillRunRef.current = null;
        updateBlockedReason(null);
        updateReachedTop(true);
        return "reachedTop";
      }

      updateReachedTop(false);
      return "fetched";
    } catch (error) {
      if (!isActiveGeneration(generation)) return "stale";
      if (error instanceof DOMException && error.name === "AbortError") return "stale";
      fillRunRef.current = null;
      updateBlockedReason("error");
      diag("history", "viewport fill failed", {
        sessionId: generation.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    } finally {
      // exact owner만 자기 loading projection을 내릴 수 있다. 이전 generation의
      // 늦은 finally는 새 generation/request의 owner와 일치하지 않는다.
      if (activeRequestRef.current === requestOwner) {
        activeRequestRef.current = null;
        if (isActiveGeneration(generation)) setLoading(false);
      }
    }
  }, [isActiveGeneration, updateBlockedReason, updateReachedTop]);

  const loadNextPage = useCallback(async (run: FillRun): Promise<HistoryPageOutcome> => {
    const outcome = await requestHistoryPage(run);
    if (outcome === "stale" && fillRunRef.current === run) {
      fillRunRef.current = null;
    }
    if (outcome === "busy" && fillRunRef.current === run) {
      fillRunRef.current = null;
      updateBlockedReason("error");
    }
    return outcome;
  }, [requestHistoryPage, updateBlockedReason]);

  const beginFillRun = useCallback((
    generation: HistoryGeneration,
    source: HistoryRequestSource,
  ): void => {
    if (!isActiveGeneration(generation)) return;
    if (activeRequestRef.current !== null || fillRunRef.current !== null) return;
    if (reachedTopRef.current) return;
    if (source === "automatic" && blockedReasonRef.current !== null) return;

    const run: FillRun = {
      generation,
      pagesFetched: 0,
      awaitingCommit: false,
      source,
    };
    fillRunRef.current = run;
    void loadNextPage(run);
  }, [isActiveGeneration, loadNextPage]);

  const requestOlder = useCallback((source: HistoryRequestSource = "automatic") => {
    const generation = resolveCommittedGeneration(activationTarget);
    if (generation !== null) beginFillRun(generation, source);
  }, [activationTarget, beginFillRun, resolveCommittedGeneration]);

  const notifyViewportGeometry = useCallback(() => {
    const generation = resolveCommittedGeneration(activationTarget);
    if (generation === null || activeRequestRef.current !== null) return;

    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const filled = hasFilledHistoryViewport(scroller, VIEWPORT_FILL_MARGIN_PX);
    if (filled === null) return;

    const run = fillRunRef.current;
    if (filled) {
      if (run?.awaitingCommit) fillRunRef.current = null;
      return;
    }
    if (reachedTopRef.current || blockedReasonRef.current !== null) return;

    if (run === null) {
      beginFillRun(generation, "automatic");
      return;
    }
    if (run.generation !== generation) return;
    if (!run.awaitingCommit) return;
    if (run.pagesFetched >= MAX_VIEWPORT_FILL_PAGES) {
      fillRunRef.current = null;
      updateBlockedReason("cap");
      return;
    }

    run.awaitingCommit = false;
    void loadNextPage(run);
  }, [
    activationTarget,
    beginFillRun,
    loadNextPage,
    resolveCommittedGeneration,
    scrollerRef,
    updateBlockedReason,
  ]);

  useLayoutEffect(() => {
    // dependency 교체의 이전 cleanup과 이 setup 모두 ready gate를 먼저 닫는다.
    // 따라서 descendant callback-ref/layout effect가 이 effect보다 먼저 실행되어도
    // render candidate로 request를 시작할 수 없다.
    activeGenerationRef.current = null;
    const staleRequest = activeRequestRef.current;
    activeRequestRef.current = null;
    staleRequest?.abortController.abort();
    fillRunRef.current = null;
    setLoading(false);

    const configuredHistory = configuredHistoryRef.current;
    const configurationChanged = activationTarget.sessionId === null
      ? configuredHistory !== null
      : configuredHistory?.sessionId !== activationTarget.sessionId
        || configuredHistory?.historyResetVersion !== activationTarget.historyResetVersion;
    if (configurationChanged) {
      configuredHistoryRef.current = activationTarget.sessionId === null
        ? null
        : {
            sessionId: activationTarget.sessionId,
            historyResetVersion: activationTarget.historyResetVersion,
          };
      reachedTopRef.current = false;
      blockedReasonRef.current = null;
      nextCursorRef.current = null;
      initialPageLoadedRef.current = false;
      setReachedTop(false);
      setBlockedReason(null);
    }

    if (!activationTarget.enabled || activationTarget.sessionId === null) return;

    const generation: HistoryGeneration = {
      token: activationTarget.token,
      sessionId: activationTarget.sessionId,
      historyResetVersion: activationTarget.historyResetVersion,
      ready: true,
    };
    activeGenerationRef.current = generation;
    if (!initialPageLoadedRef.current) beginFillRun(generation, "automatic");

    return () => {
      if (activeGenerationRef.current === generation) {
        activeGenerationRef.current = null;
      }
      const request = activeRequestRef.current;
      if (request?.generation === generation) {
        activeRequestRef.current = null;
        request.abortController.abort();
      }
      if (fillRunRef.current?.generation === generation) {
        fillRunRef.current = null;
      }
    };
  }, [activationTarget, beginFillRun]);

  return {
    loading,
    reachedTop,
    blockedReason,
    requestOlder,
    notifyViewportGeometry,
  };
}
