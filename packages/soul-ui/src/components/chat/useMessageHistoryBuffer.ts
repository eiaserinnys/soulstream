/**
 * useMessageHistoryBuffer — ChatView용 과거 메시지 페치 + 트리 통합 (옵션 D)
 *
 * 목적:
 * - `GET /api/sessions/{id}/messages` 응답을 라이브 SSE와 동일한 event-processor
 *   파이프라인을 통해 store.tree에 통합한다 (단일 정본).
 * - 위로 스크롤 시 `before` 커서로 과거 메시지를 prepend하고 prependedCount를 누적한다.
 * - `next_cursor === null` 도달 시 "맨 위" 인디케이터를 표시한다.
 *
 * 설계 (옵션 D):
 * - **단일 트리 정본**: 라이브 SSE와 히스토리가 같은 store.tree를 공유한다.
 *   `historicalMessages`/`liveMessages` 병합 dedup이 폐기된다.
 * - **eventId dedup 자동**: processEventsBatch가 `eventId <= lastEventId`로 자체 dedup한다
 *   (event-processor.ts:228). 외부 dedup 불필요.
 * - **orphan queue**: prepend 페이지 경계에서 부모가 아직 미수신인 자식 노드는
 *   ProcessingContext.orphans에 보관 → 부모 도착 시 자동 attach (tree-placer.ts).
 * - **세션 전환 시 초기화**: activeSessionKey가 바뀌면 prependedCount, 커서, 상태 모두 리셋.
 * - **중복 요청 방지**: loading 중에는 추가 prepend 요청을 무시한다.
 * - **fetch 실패 격리**: 예외를 삼키고 라이브 SSE 파이프라인을 단독 소스로 유지한다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SoulSSEEvent } from "@shared/types";
import { useDashboardStore } from "../../stores/dashboard-store";
import { diag } from "../../lib/diag";

/** 초기 로드 / prepend 페이지 크기 */
export const HISTORY_PAGE_SIZE = 50;

/** prepend 응답 후 다음 요청까지 최소 대기 시간 (ms).
 *  startReached 연쇄 트리거(scrollTop이 상단 근처인 채로 유지되는 경우)를 방지한다. */
export const PREPEND_COOLDOWN_MS = 500;

/** 서버 응답의 단일 메시지 (soul_common.db.session_db.read_messages) */
export interface HistoricalMessage {
  id: number;
  parent_event_id: number | null;
  event_type: string;
  payload: Record<string, unknown>;
  /** ISO8601 timestamp */
  created_at: string;
}

/** 서버 응답 페이로드 */
interface MessagesResponse {
  messages: HistoricalMessage[];
  /** 다음 페이지 커서 (ISO timestamp). null이면 더 이상 과거 메시지 없음 */
  next_cursor: string | null;
}

export interface UseMessageHistoryBufferResult {
  /** 추가 페이지 로드 중 여부 */
  loading: boolean;
  /** true일 때 "맨 위 도달" 인디케이터를 렌더링 */
  reachedTop: boolean;
  /** 위로 스크롤 시 호출하여 과거 페이지 prepend. 중복 호출은 자동 무시된다. */
  requestOlder: () => void;
  /**
   * 누적 prepend 메시지 수 (flattenTree 차분 기반).
   * virtuoso `firstItemIndex = START_INDEX - prependedCount` 패턴에서 사용한다.
   * 세션 전환 시 0으로 리셋된다.
   */
  prependedCount: number;
}

/**
 * messages payload를 SoulSSEEvent로 정규화한다.
 *
 * DB는 `event_type`을 별도 컬럼으로 저장하지만 SSE 라이브는 `payload.type`을 쓴다.
 * payload 자체에 `type`이 있으면 그것을 우선, 없으면 `event_type`을 type으로 주입한다.
 *
 * ⚠️ spread 순서 주의: `...m.payload`를 먼저 펼치고 `type`을 마지막에 두어야
 * `payload.type`이 있어도 우리가 정한 type 값이 보존된다.
 */
export function toSSEEvent(m: HistoricalMessage): { event: SoulSSEEvent; eventId: number } {
  const payload = m.payload as Record<string, unknown>;
  const payloadType = (payload.type as string | undefined);

  // DB JSONB는 ID 필드를 number로 저장하지만, 라이브 SSE는 string으로 직렬화된다.
  // nodeMap 키가 String(eventId)이므로 lookup 실패(Map.get(2410) ≠ Map.get("2410"))를 방지하려면
  // ID 필드를 string으로 명시 정규화해야 한다.
  // 진단 결과: parent_event_id number → orphan 큐 영구 보관 → 채팅 미렌더링.
  const event = {
    ...payload,
    type: payloadType ?? m.event_type,
    ...(payload.parent_event_id != null ? { parent_event_id: String(payload.parent_event_id) } : {}),
    ...(payload.tool_use_id != null ? { tool_use_id: String(payload.tool_use_id) } : {}),
    ...(payload.request_id != null ? { request_id: String(payload.request_id) } : {}),
  } as SoulSSEEvent;
  return { event, eventId: m.id };
}

export function useMessageHistoryBuffer(
  sessionId: string | null,
): UseMessageHistoryBufferResult {
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const [prependedCount, setPrependedCount] = useState(0);

  // 동시성 가드 — 세션 전환/언마운트 시 stale fetch 결과를 버리기 위함
  const sessionTokenRef = useRef<symbol>(Symbol("initial"));
  const loadingRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);
  const reachedTopRef = useRef(false);
  /** prepend 후 cooldown 활성 여부 */
  const cooldownRef = useRef(false);
  /** cooldown 해제 타이머 — 세션 전환 시 clearTimeout으로 정리 */
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    reachedTopRef.current = reachedTop;
  }, [reachedTop]);

  // 세션 전환: 상태 리셋 + 초기 페이지 로드
  useEffect(() => {
    const token = Symbol("session");
    sessionTokenRef.current = token;

    setNextCursor(null);
    setReachedTop(false);
    setLoading(false);
    setPrependedCount(0);
    // 이전 세션의 cooldown 타이머가 새 세션의 cooldown을 오염하지 않도록 정리
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
    cooldownRef.current = false;

    if (!sessionId) return;

    setLoading(true);
    loadingRef.current = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${HISTORY_PAGE_SIZE}`,
          { credentials: "include" },
        );
        if (sessionTokenRef.current !== token) return;
        if (!res.ok) return;
        const data = (await res.json()) as MessagesResponse;
        if (sessionTokenRef.current !== token) return;

        // 시간 ASC로 뒤집어서 store에 흘림 (부모가 자식 이전에 처리되도록)
        const events = [...(data.messages ?? [])].reverse().map(toSSEEvent);
        diag("history", "initial load", {
          sessionId,
          received: data.messages?.length ?? 0,
          eventTypes: events.reduce<Record<string, number>>((acc, { event }) => {
            acc[event.type] = (acc[event.type] ?? 0) + 1;
            return acc;
          }, {}),
          firstEventId: events[0]?.eventId,
          lastEventId: events[events.length - 1]?.eventId,
          nextCursor: data.next_cursor,
        });
        const result = useDashboardStore.getState().processHistoryEvents(events);
        diag("history", "initial load done", { addedCount: result.addedCount });

        // 초기 로드는 prepend가 아니므로 prependedCount에 더하지 않는다.
        // (virtuoso는 START_INDEX 기준으로 자연스럽게 표시)

        setNextCursor(data.next_cursor ?? null);
        if (data.next_cursor === null) setReachedTop(true);
      } catch {
        // 네트워크 오류는 무시 — 라이브 SSE가 단독 소스
      } finally {
        if (sessionTokenRef.current === token) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    })();
  }, [sessionId]);

  // 위로 스크롤 트리거 → 다음 페이지 prepend
  const requestOlder = useCallback(() => {
    if (!sessionId) return;
    if (loadingRef.current) return;
    if (cooldownRef.current) return;
    if (reachedTopRef.current) return;
    const cursor = nextCursorRef.current;
    if (!cursor) return;

    const token = sessionTokenRef.current;
    setLoading(true);
    loadingRef.current = true;
    (async () => {
      try {
        const qs = new URLSearchParams({
          before: cursor,
          limit: String(HISTORY_PAGE_SIZE),
        });
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/messages?${qs}`,
          { credentials: "include" },
        );
        if (sessionTokenRef.current !== token) return;
        if (!res.ok) return;
        const data = (await res.json()) as MessagesResponse;
        if (sessionTokenRef.current !== token) return;

        const events = [...(data.messages ?? [])].reverse().map(toSSEEvent);
        diag("history", "prepend page", {
          sessionId,
          before: cursor,
          received: data.messages?.length ?? 0,
        });
        const { addedCount } = useDashboardStore.getState().processHistoryEvents(events);
        diag("history", "prepend done", { addedCount });

        if (addedCount > 0) {
          setPrependedCount((c) => c + addedCount);
        }
        setNextCursor(data.next_cursor ?? null);
        if (data.next_cursor === null) setReachedTop(true);
      } catch {
        // 네트워크 오류는 무시
      } finally {
        if (sessionTokenRef.current === token) {
          setLoading(false);
          loadingRef.current = false;
          cooldownRef.current = true;
          if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
          cooldownTimerRef.current = setTimeout(() => {
            cooldownRef.current = false;
            cooldownTimerRef.current = null;
          }, PREPEND_COOLDOWN_MS);
        }
      }
    })();
  }, [sessionId]);

  return { loading, reachedTop, requestOlder, prependedCount };
}
