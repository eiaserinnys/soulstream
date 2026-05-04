/**
 * useSessionStreamSSE - 세션 스트림 EventSource 연결/재연결 관리 훅
 *
 * 책임:
 * - EventSource 라이프사이클 관리 (useEffect 기반 연결/해제)
 * - 이벤트 파싱 및 타입별 콜백 라우팅
 * - 지수 백오프(exponential backoff) 기반 재연결
 * - SSE id를 이벤트 페이로드에 주입 (Last-Event-ID 추적)
 *
 * 이 훅은 TanStack Query 캐시나 store를 직접 다루지 않는다.
 * 호출자가 콜백을 통해 이벤트별 후처리를 주입한다.
 *
 * 정본 단일화: 이전의 `url: string` + `onReconnect` 조합은 lastEventId/instanceId
 * 변경마다 effect 재발화로 SSE가 매번 끊겼다 붙는 비효율을 만들었고, "재연결 신호"가
 * url 차원과 onReconnect 차원에 동시에 존재하여 design-principles §3 위배. urlBuilder
 * 단일 패턴 + replay_gap/stream_meta 신호 기반 refetch로 통일한다.
 */

import { useCallback, useEffect, useRef } from "react";
import type {
  CatalogUpdatedStreamEvent,
  MetadataUpdatedStreamEvent,
  ReplayGapStreamEvent,
  SessionCreatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionListStreamEvent,
  SessionUpdatedStreamEvent,
  StreamMetaStreamEvent,
} from "../shared/stream-events";
import {
  dispatchSessionStreamEvent,
  parseStreamMessage,
} from "./session-stream-dispatch";

/**
 * 서버가 named SSE event로 보내는 이벤트 타입 목록.
 *
 * Phase 2 (orch broadcaster Last-Event-ID resume):
 * - `stream_meta`: 구독 시 최초 1회 (instance_id + latest_id, SSE id 미부착)
 * - `replay_gap`: ring buffer 부족 신호 (latest_id 동기화용, SSE id 미부착)
 * 나머지 5종은 SSE id 부착.
 */
const SESSION_STREAM_EVENT_TYPES = [
  "stream_meta",
  "session_list",
  "session_created",
  "session_updated",
  "session_deleted",
  "catalog_updated",
  "metadata_updated",
  "replay_gap",
] as const;

const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

export interface UseSessionStreamSSEOptions {
  /** 구독 활성화 여부. false면 연결하지 않는다. */
  enabled: boolean;
  /**
   * 매 connect 시(첫 연결 + 재연결마다) 호출되어 최신 URL을 반환한다.
   *
   * 빈 문자열을 반환하면 connect를 건너뛴다. urlBuilderRef로 보관되어
   * useEffect deps에 들어가지 않는다 — 무한 재연결 방지.
   */
  urlBuilder: () => string;

  onSessionList?: (event: SessionListStreamEvent) => void;
  onSessionCreated?: (event: SessionCreatedStreamEvent) => void;
  onSessionUpdated?: (event: SessionUpdatedStreamEvent) => void;
  onSessionDeleted?: (event: SessionDeletedStreamEvent) => void;
  onCatalogUpdated?: (event: CatalogUpdatedStreamEvent) => void;
  onMetadataUpdated?: (event: MetadataUpdatedStreamEvent) => void;
  onStreamMeta?: (event: StreamMetaStreamEvent) => void;
  onReplayGap?: (event: ReplayGapStreamEvent) => void;
}

/**
 * 세션 스트림 EventSource 연결을 관리한다.
 * enabled가 바뀌면 재연결하고, 언마운트 시 연결을 해제한다.
 * URL 변경(lastEventId/instanceId)은 자연 재연결 시 urlBuilder를 통해 반영된다.
 */
export function useSessionStreamSSE(options: UseSessionStreamSSEOptions): void {
  const { enabled } = options;

  // 콜백을 단일 ref로 보관 — 콜백 identity 변화로 연결이 재설정되지 않도록 한다.
  // 매 렌더마다 current를 갱신하므로 useEffect 불필요.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // urlBuilder도 ref로 보관 — useEffect deps에서 제외하여 매 렌더마다 SSE가
  // 끊겼다 붙는 것을 방지. connect 시 매번 urlBuilderRef.current()를 호출.
  const urlBuilderRef = useRef(options.urlBuilder);
  urlBuilderRef.current = options.urlBuilder;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  const connect = useCallback(() => {
    if (eventSourceRef.current) return;

    // 매 connect 시 urlBuilder를 호출하여 최신 URL을 얻는다 — retry 시 lastEventId가
    // 갱신되어 있으면 자연스럽게 resume URL이 만들어진다.
    const targetUrl = urlBuilderRef.current();
    if (!targetUrl) return;

    const eventSource = new EventSource(targetUrl);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      reconnectAttemptRef.current = 0;
    };

    for (const eventType of SESSION_STREAM_EVENT_TYPES) {
      eventSource.addEventListener(eventType, (e: MessageEvent) => {
        const enriched = parseStreamMessage(e.data, e.lastEventId);
        if (enriched) dispatchSessionStreamEvent(enriched, optionsRef.current);
      });
    }

    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        console.warn(
          "[SSE] EventSource CLOSED, reconnecting with backoff...",
        );
        eventSourceRef.current = null;
        const delay = Math.min(
          BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptRef.current),
          MAX_RECONNECT_DELAY_MS,
        );
        reconnectAttemptRef.current++;
        if (reconnectTimerRef.current)
          clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    connect();

    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);
}
