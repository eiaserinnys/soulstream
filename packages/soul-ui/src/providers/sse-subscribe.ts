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

function resolveEventId(data: SoulSSEEvent, sseLastEventId: string): number {
  const record = data as unknown as Record<string, unknown>;
  if (record._live_only === true) return 0;

  const payloadEventId = record._event_id;
  if (typeof payloadEventId === "number" && Number.isFinite(payloadEventId)) {
    return payloadEventId;
  }

  const parsed = sseLastEventId ? parseInt(sseLastEventId, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
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

    const params = new URLSearchParams();
    if (currentLastEventId > 0) {
      params.set("lastEventId", String(currentLastEventId));
    }
    const qs = params.toString();
    const url = qs ? `${baseUrl}?${qs}` : baseUrl;

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
          const eventId = resolveEventId(data, e.lastEventId);

          // history_sync는 SSE id 없이 payload.last_event_id로 baseline 전달.
          // 재연결 시 정확한 lastEventId를 보내려면 이 baseline을 currentLastEventId에 반영해야 한다.
          // SoulSSEEvent union에서 type narrowing으로 HistorySyncEvent로 좁혀 직접 접근.
          if (data?.type === "history_sync") {
            const syncId = data.last_event_id ?? 0;
            if (syncId > currentLastEventId) {
              currentLastEventId = syncId;
            }
          } else if (eventId > currentLastEventId) {
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
