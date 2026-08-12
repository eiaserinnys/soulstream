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
  useEffect,
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
  token: symbol;
  pagesFetched: number;
  awaitingCommit: boolean;
  source: HistoryRequestSource;
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
): Promise<TimelineResponse> {
  const response = await fetch(buildHistoryPageUrl(sessionId, before), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`timeline request failed: ${response.status}`);
  }
  return (await response.json()) as TimelineResponse;
}

export function useMessageHistoryBuffer(
  sessionId: string | null,
  scrollerRef: RefObject<HTMLElement | null>,
): UseMessageHistoryBufferResult {
  const [loading, setLoading] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const [blockedReason, setBlockedReason] =
    useState<HistoryLoadBlockReason | null>(null);

  // loadingRef가 in-flight의 유일한 동기 정본이다. state는 표시용 projection이다.
  const loadingRef = useRef(false);
  const reachedTopRef = useRef(false);
  const blockedReasonRef = useRef<HistoryLoadBlockReason | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const initialPageLoadedRef = useRef(false);
  const sessionTokenRef = useRef<symbol>(Symbol("initial"));
  const configuredSessionRef = useRef<string | null>(null);
  const fillRunRef = useRef<FillRun | null>(null);

  const isCurrentSession = useCallback((token: symbol): boolean => (
    sessionId !== null
    && sessionTokenRef.current === token
    && useDashboardStore.getState().activeSessionKey === sessionId
  ), [sessionId]);

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
    if (!sessionId || !isCurrentSession(run.token)) return "stale";
    if (loadingRef.current) return "busy";
    if (reachedTopRef.current) return "reachedTop";

    const before = initialPageLoadedRef.current ? nextCursorRef.current : null;
    if (initialPageLoadedRef.current && before === null) return "reachedTop";

    loadingRef.current = true;
    setLoading(true);
    try {
      const data = await fetchHistoryPage(sessionId, before);
      if (!isCurrentSession(run.token)) return "stale";

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
      if (!isCurrentSession(run.token)) return "stale";
      const events = [...messages].reverse().map(toSSEEvent);
      // store update가 만든 React commit부터 geometry 신호를 받을 준비를 끝낸다.
      run.awaitingCommit = true;
      const { addedCount } = useDashboardStore.getState().processHistoryEvents(events);
      if (!isCurrentSession(run.token)) return "stale";

      initialPageLoadedRef.current = true;
      nextCursorRef.current = nextCursor;
      run.pagesFetched += 1;
      if (run.source === "manual") updateBlockedReason(null);

      diag("history", "viewport fill page", {
        sessionId,
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
      if (!isCurrentSession(run.token)) return "stale";
      fillRunRef.current = null;
      updateBlockedReason("error");
      diag("history", "viewport fill failed", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    } finally {
      // stale completion이 새 session의 in-flight projection을 덮지 않게 한다.
      if (isCurrentSession(run.token)) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [isCurrentSession, sessionId, updateBlockedReason, updateReachedTop]);

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

  const beginFillRun = useCallback((source: HistoryRequestSource): void => {
    if (!sessionId || configuredSessionRef.current !== sessionId) return;
    if (loadingRef.current || fillRunRef.current !== null) return;
    if (reachedTopRef.current) return;
    if (source === "automatic" && blockedReasonRef.current !== null) return;

    const run: FillRun = {
      token: sessionTokenRef.current,
      pagesFetched: 0,
      awaitingCommit: false,
      source,
    };
    fillRunRef.current = run;
    void loadNextPage(run);
  }, [loadNextPage, sessionId]);

  const requestOlder = useCallback((source: HistoryRequestSource = "automatic") => {
    beginFillRun(source);
  }, [beginFillRun]);

  const notifyViewportGeometry = useCallback(() => {
    if (
      !sessionId
      || configuredSessionRef.current !== sessionId
      || loadingRef.current
    ) return;
    const token = sessionTokenRef.current;
    if (!isCurrentSession(token)) return;

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
      beginFillRun("automatic");
      return;
    }
    if (!run.awaitingCommit) return;
    if (run.pagesFetched >= MAX_VIEWPORT_FILL_PAGES) {
      fillRunRef.current = null;
      updateBlockedReason("cap");
      return;
    }

    run.awaitingCommit = false;
    void loadNextPage(run);
  }, [beginFillRun, isCurrentSession, loadNextPage, scrollerRef, sessionId, updateBlockedReason]);

  useEffect(() => {
    const token = Symbol("session");
    sessionTokenRef.current = token;
    configuredSessionRef.current = sessionId;
    loadingRef.current = false;
    reachedTopRef.current = false;
    blockedReasonRef.current = null;
    nextCursorRef.current = null;
    initialPageLoadedRef.current = false;
    fillRunRef.current = null;
    setLoading(false);
    setReachedTop(false);
    setBlockedReason(null);

    if (sessionId !== null) {
      beginFillRun("automatic");
    }

    return () => {
      if (sessionTokenRef.current === token) {
        sessionTokenRef.current = Symbol("disposed");
        configuredSessionRef.current = null;
        fillRunRef.current = null;
      }
    };
  }, [beginFillRun, sessionId]);

  return {
    loading,
    reachedTop,
    blockedReason,
    requestOlder,
    notifyViewportGeometry,
  };
}
