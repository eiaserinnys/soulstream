/**
 * useMessageHistoryBuffer — ChatView용 과거 메시지 로컬 버퍼 (Phase 3)
 *
 * 목적:
 * - `GET /api/sessions/{id}/messages` 응답을 로컬 버퍼로 유지
 * - 위로 스크롤 시 `before` 커서로 과거 메시지를 prepend
 * - `next_cursor === null` 도달 시 "맨 위" 인디케이터 표시
 *
 * 설계:
 * - **store.tree와 공존**: flattenTree(tree)가 라이브 SSE로 쌓은 메시지를 반환하고,
 *   이 버퍼는 DB에서 가져온 과거 메시지를 보관한다. 렌더러가 `event_id`(여기서는 `id`)
 *   기준으로 dedup하여 시간순 병합한다.
 * - **세션 전환 시 초기화**: activeSessionKey가 바뀌면 버퍼, 커서, 상태를 모두 리셋.
 * - **중복 요청 방지**: loading 중에는 추가 prepend 요청을 무시한다.
 * - **fetch 실패 격리**: 예외를 삼키고 기존 SSE 파이프라인을 소스 오브 트루스로 유지한다.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** 초기 로드 / prepend 페이지 크기 */
export const HISTORY_PAGE_SIZE = 50;

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
  /** 지금까지 로드된 과거 메시지들 (시간 오름차순) */
  messages: HistoricalMessage[];
  /** 추가 페이지 로드 중 여부 */
  loading: boolean;
  /** true일 때 "맨 위 도달" 인디케이터를 렌더링 */
  reachedTop: boolean;
  /** 위로 스크롤 시 호출하여 과거 페이지 prepend. 중복 호출은 자동 무시된다. */
  requestOlder: () => void;
  /**
   * 누적 prepend 개수. virtuoso `firstItemIndex = START_INDEX - prependedCount`
   * 패턴에서 사용한다. 세션 전환 시 0으로 리셋된다.
   */
  prependedCount: number;
}

export function useMessageHistoryBuffer(
  sessionId: string | null,
): UseMessageHistoryBufferResult {
  const [messages, setMessages] = useState<HistoricalMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const [prependedCount, setPrependedCount] = useState(0);

  // 동시성 가드 — 세션 전환/언마운트 시 stale fetch 결과를 버리기 위함
  const sessionTokenRef = useRef<symbol>(Symbol("initial"));
  const loadingRef = useRef(false);
  const nextCursorRef = useRef<string | null>(null);
  const reachedTopRef = useRef(false);
  /**
   * strict mode에서 이펙트가 2회 실행될 때 stale closure 상태를 피하기 위해
   * messages의 현재 값을 ref에 미러링한다. requestOlder의 중복 가드가
   * setMessages 콜백의 `prev` 대신 이 ref를 사용하여 setPrependedCount와
   * 일관된 unique 개수를 계산한다.
   */
  const messagesRef = useRef<HistoricalMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    reachedTopRef.current = reachedTop;
  }, [reachedTop]);

  // 세션 전환: 버퍼 리셋 + 초기 페이지 로드
  useEffect(() => {
    // 이전 fetch를 무효화하기 위한 새 토큰
    const token = Symbol("session");
    sessionTokenRef.current = token;

    // 상태 리셋
    setMessages([]);
    setNextCursor(null);
    setReachedTop(false);
    setLoading(false);
    setPrependedCount(0);

    if (!sessionId) return;

    // 초기 페이지 로드 (before 없음 = 가장 최근부터)
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
        // 서버는 created_at DESC로 반환 → 렌더 편의를 위해 오름차순으로 뒤집는다
        const asc = [...(data.messages ?? [])].reverse();
        setMessages(asc);
        setNextCursor(data.next_cursor ?? null);
        if (data.next_cursor === null) setReachedTop(true);
      } catch {
        // 네트워크 오류는 무시 — 라이브 SSE가 소스 오브 트루스
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
        const asc = [...(data.messages ?? [])].reverse();
        // 중복 가드: 이미 버퍼에 있는 id는 제외 (동일 커서 연속 호출 시 안전 장치)
        const existingIds = new Set(messagesRef.current.map((m) => m.id));
        const unique = asc.filter((m) => !existingIds.has(m.id));
        if (unique.length > 0) {
          setMessages((prev) => [...unique, ...prev]);
          setPrependedCount((c) => c + unique.length);
        }
        setNextCursor(data.next_cursor ?? null);
        if (data.next_cursor === null) setReachedTop(true);
      } catch {
        // 네트워크 오류는 무시
      } finally {
        if (sessionTokenRef.current === token) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    })();
  }, [sessionId]);

  return { messages, loading, reachedTop, requestOlder, prependedCount };
}
