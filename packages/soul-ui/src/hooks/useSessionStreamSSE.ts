/**
 * useSessionStreamSSE - 세션 스트림 EventSource 연결/재연결 관리 훅
 *
 * 책임:
 * - EventSource 라이프사이클 관리 (useEffect 기반 연결/해제)
 * - 이벤트 파싱 및 타입별 콜백 라우팅
 * - 지수 백오프(exponential backoff) 기반 재연결
 * - 재연결 후 onReconnect 콜백 호출 (refetch 트리거 등)
 *
 * 이 훅은 TanStack Query 캐시나 store를 직접 다루지 않는다.
 * 호출자가 콜백을 통해 이벤트별 후처리를 주입한다.
 */

import { useCallback, useEffect, useRef } from "react";
import type {
  CatalogUpdatedStreamEvent,
  MetadataUpdatedStreamEvent,
  SessionCreatedStreamEvent,
  SessionDeletedStreamEvent,
  SessionListStreamEvent,
  SessionStreamEvent,
  SessionUpdatedStreamEvent,
} from "../shared/stream-events";

/** 서버가 named SSE event로 보내는 이벤트 타입 목록 */
const SESSION_STREAM_EVENT_TYPES = [
  "session_list",
  "session_created",
  "session_updated",
  "session_deleted",
  "catalog_updated",
  "metadata_updated",
] as const;

const BASE_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

export interface UseSessionStreamSSEOptions {
  /** 구독 활성화 여부. false면 연결하지 않는다. */
  enabled: boolean;
  /** EventSource URL. enabled가 true일 때만 사용된다. */
  url: string;

  onSessionList?: (event: SessionListStreamEvent) => void;
  onSessionCreated?: (event: SessionCreatedStreamEvent) => void;
  onSessionUpdated?: (event: SessionUpdatedStreamEvent) => void;
  onSessionDeleted?: (event: SessionDeletedStreamEvent) => void;
  onCatalogUpdated?: (event: CatalogUpdatedStreamEvent) => void;
  onMetadataUpdated?: (event: MetadataUpdatedStreamEvent) => void;

  /** 에러 후 재연결이 성공했을 때 호출된다 (상태 재동기화용 refetch 등). */
  onReconnect?: () => void;
}

/**
 * 세션 스트림 EventSource 연결을 관리한다.
 * enabled/url이 바뀌면 재연결하고, 언마운트 시 연결을 해제한다.
 */
export function useSessionStreamSSE(options: UseSessionStreamSSEOptions): void {
  const { enabled, url } = options;

  // 콜백을 단일 ref로 보관 — 콜백 identity 변화로 연결이 재설정되지 않도록 한다.
  // 매 렌더마다 current를 갱신하므로 useEffect 불필요.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  const dispatchEvent = useCallback((event: SessionStreamEvent) => {
    const cbs = optionsRef.current;
    switch (event.type) {
      case "session_list":
        cbs.onSessionList?.(event);
        break;
      case "session_created":
        cbs.onSessionCreated?.(event);
        break;
      case "session_updated":
        cbs.onSessionUpdated?.(event);
        break;
      case "session_deleted":
        cbs.onSessionDeleted?.(event);
        break;
      case "catalog_updated":
        cbs.onCatalogUpdated?.(event);
        break;
      case "metadata_updated":
        cbs.onMetadataUpdated?.(event);
        break;
    }
  }, []);

  const connect = useCallback(
    (targetUrl: string) => {
      if (eventSourceRef.current) return;

      const eventSource = new EventSource(targetUrl);
      eventSourceRef.current = eventSource;

      let hadError = false;

      eventSource.onopen = () => {
        reconnectAttemptRef.current = 0;
        if (hadError) {
          optionsRef.current.onReconnect?.();
        }
        hadError = false;
      };

      for (const eventType of SESSION_STREAM_EVENT_TYPES) {
        eventSource.addEventListener(eventType, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as SessionStreamEvent;
            dispatchEvent(data);
          } catch {
            // JSON 파싱 실패: 무시
          }
        });
      }

      eventSource.onerror = () => {
        hadError = true;
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
            connect(targetUrl);
          }, delay);
        }
      };
    },
    [dispatchEvent],
  );

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

    connect(url);

    return () => {
      disconnect();
    };
  }, [enabled, url, connect, disconnect]);
}
