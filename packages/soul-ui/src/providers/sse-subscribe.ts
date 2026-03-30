/**
 * createSSESubscribe - 재사용 가능한 SSE 구독 유틸리티
 *
 * SSESessionProvider와 OrchestratorSessionProvider에서 공유하는
 * EventSource 연결·재연결·lastEventId 추적 로직을 캡슐화합니다.
 */

import type { SoulSSEEvent } from "@shared/types";
import { SSE_EVENT_TYPES } from "@shared/constants";

export interface SSESubscribeOptions {
  /**
   * SSE 엔드포인트 기본 URL. 쿼리 파라미터 없이 전달한다.
   * 재연결 시 lastEventId > 0이면 ?lastEventId=N을 자동으로 추가한다.
   * 예: `/api/sessions/abc123/events`
   */
  baseUrl: string;

  /** SSE 이벤트 수신 콜백 */
  onEvent: (data: SoulSSEEvent, eventId: number) => void;

  /** 연결 상태 변경 콜백 (선택) */
  onStatusChange?: (status: "connecting" | "connected" | "error") => void;

  /**
   * 구독 시작 시점의 lastEventId.
   * 이 값을 기준으로 내부 currentLastEventId가 초기화되며,
   * 이후 수신된 이벤트 ID로 자동 갱신된다.
   */
  initialLastEventId?: number;

  /**
   * 디버그 로그 접두어.
   * 전달하면 console.log로 연결·이벤트·재연결 상태를 출력한다.
   * undefined면 로그를 출력하지 않는다.
   * 예: "[OrchestratorSSE][abc123456789]"
   */
  debugPrefix?: string;
}

/**
 * SSE 스트림을 구독하고 구독 해제 함수를 반환한다.
 *
 * - EventSource 연결, lastEventId 추적, 지수 백오프 재연결을 처리한다.
 * - currentLastEventId는 클로저 내부에서 관리하며, 재연결 시 URL에 반영된다.
 *
 * @returns 구독 해제 함수
 */
export function createSSESubscribe(options: SSESubscribeOptions): () => void {
  const { baseUrl, onEvent, onStatusChange, debugPrefix } = options;

  let currentLastEventId = options.initialLastEventId ?? 0;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const maxReconnectAttempts = 20;
  const reconnectIntervalMs = 3000;
  const maxReconnectIntervalMs = 30000;

  const log = debugPrefix
    ? (...args: unknown[]) => console.log(debugPrefix, ...args)
    : () => {};

  const connect = () => {
    onStatusChange?.("connecting");

    const url =
      currentLastEventId > 0
        ? `${baseUrl}?lastEventId=${currentLastEventId}`
        : baseUrl;

    log(`connecting → ${url} (attempt=${reconnectAttempt})`);

    const es = new EventSource(url);
    eventSource = es;

    es.onopen = () => {
      reconnectAttempt = 0;
      log("connected ✓");
      onStatusChange?.("connected");
    };

    for (const eventType of SSE_EVENT_TYPES) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as SoulSSEEvent;
          const eventId = e.lastEventId ? parseInt(e.lastEventId, 10) : 0;

          if (eventId > currentLastEventId) {
            currentLastEventId = eventId;
          }

          log(`event type=${eventType} id=${eventId}`, data);
          onEvent(data, eventId);
        } catch (err) {
          log(`JSON parse error on type=${eventType}`, err);
        }
      });
    }

    es.onerror = (e) => {
      // 서버가 보낸 named "error" 이벤트는 MessageEvent로 도착.
      // 세션 히스토리의 노드일 뿐이므로 연결을 끊지 않는다.
      if (e instanceof MessageEvent) {
        log("server 'error' event (MessageEvent):", e.data);
        return;
      }

      log(`connection error → closing. attempt=${reconnectAttempt}/${maxReconnectAttempts}`);
      es.close();
      eventSource = null;
      onStatusChange?.("error");

      if (reconnectAttempt < maxReconnectAttempts) {
        const delay = Math.min(
          reconnectIntervalMs * Math.pow(2, reconnectAttempt),
          maxReconnectIntervalMs,
        );
        reconnectAttempt++;
        log(`reconnecting in ${delay}ms (attempt=${reconnectAttempt})`);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, delay);
      } else {
        log("max reconnect attempts reached — giving up");
      }
    };
  };

  connect();

  return () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
