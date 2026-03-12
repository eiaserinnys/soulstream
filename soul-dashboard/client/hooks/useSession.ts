/**
 * useSession - SSE 구독 훅
 *
 * 특정 세션의 /api/sessions/:id/events SSE 스트림을 구독합니다.
 * Last-Event-ID를 지원하여 재연결 시 놓친 이벤트를 복구합니다.
 *
 * 히스토리 리플레이 최적화:
 * - SSE 이벤트를 즉시 처리하지 않고 큐에 버퍼링
 * - BATCH_SIZE 단위로 processEvents (set() 1회)
 * - 청크 간 setTimeout(0)으로 메인 스레드에 양보 → UI 프리징 방지
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import type { SoulSSEEvent, SSEEventType } from "@shared/types";

interface UseSessionOptions {
  /** 구독할 세션 키 (agentSessionId). null이면 구독 안 함 */
  sessionKey: string | null;
  /** 자동 재연결 활성화. 기본 true */
  autoReconnect?: boolean;
  /** 재연결 간격 (ms). 기본 3000 */
  reconnectIntervalMs?: number;
  /** 최대 재연결 간격 (ms). 기본 30000 */
  maxReconnectIntervalMs?: number;
  /** 최대 재연결 시도 횟수. 기본 20 */
  maxReconnectAttempts?: number;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** SSE 이벤트 타입 목록 (구독 등록용) */
const SSE_EVENT_TYPES: SSEEventType[] = [
  "progress",
  "memory",
  "session",
  "intervention_sent",
  "user_message",
  "assistant_message",
  "input_request",
  "debug",
  "complete",
  "error",
  "thinking",
  "text_start",
  "text_delta",
  "text_end",
  "tool_start",
  "tool_result",
  "result",
  "subagent_start",
  "subagent_stop",
  "context_usage",
  "compact",
  "reconnect",
];

// 주의: complete/error는 "턴" 종료이지 "세션" 종료가 아닙니다.
// 멀티턴 세션에서는 complete 후 새 user_message가 올 수 있으므로
// 클라이언트가 SSE 연결을 끊으면 안 됩니다.

import { BATCH_SIZE, BATCH_FLUSH_MS } from "../lib/event-batch";

interface QueuedEvent {
  event: SoulSSEEvent;
  eventId: number;
}

export function useSession(options: UseSessionOptions) {
  const {
    sessionKey,
    autoReconnect = true,
    reconnectIntervalMs = 3000,
    maxReconnectIntervalMs = 30000,
    maxReconnectAttempts = 20,
  } = options;

  const processEvents = useDashboardStore((s) => s.processEvents);
  const lastEventId = useDashboardStore((s) => s.lastEventId);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  // Refs: stale closure 방지
  const processEventsRef = useRef(processEvents);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastEventIdRef = useRef(0);

  // 이벤트 큐 + 플러시 타이머
  const eventQueueRef = useRef<QueuedEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    processEventsRef.current = processEvents;
  }, [processEvents]);

  useEffect(() => {
    lastEventIdRef.current = lastEventId;
  }, [lastEventId]);

  /** 큐에 쌓인 이벤트를 청크 단위로 처리하고, 청크 간 yielding */
  const drainQueue = useCallback(() => {
    const queue = eventQueueRef.current;
    if (queue.length === 0) return;

    // 플러시 타이머 정리
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    // 첫 청크 즉시 처리
    const chunk = queue.splice(0, BATCH_SIZE);
    processEventsRef.current(chunk);

    // 남은 이벤트가 있으면 다음 틱에 이어서 처리 (메인 스레드 양보)
    if (queue.length > 0) {
      drainTimerRef.current = setTimeout(() => {
        drainTimerRef.current = null;
        drainQueue();
      }, 0);
    }
  }, []);

  /** 이벤트를 큐에 추가하고, 배치 크기에 도달하면 즉시 플러시 */
  const enqueueEvent = useCallback(
    (event: SoulSSEEvent, eventId: number) => {
      eventQueueRef.current.push({ event, eventId });

      // 배치 크기에 도달하면 즉시 drain
      if (eventQueueRef.current.length >= BATCH_SIZE) {
        drainQueue();
        return;
      }

      // 아직 배치가 차지 않으면 플러시 타이머 설정
      // (이벤트 유입이 끊겼을 때도 잔여 이벤트가 처리되도록)
      if (!flushTimerRef.current && !drainTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          drainQueue();
        }, BATCH_FLUSH_MS);
      }
    },
    [drainQueue],
  );

  /** SSE 연결 닫기 */
  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (drainTimerRef.current) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    // 잔여 이벤트 폐기 (세션 전환 시 직후 clearTree()가 호출됨)
    eventQueueRef.current.length = 0;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStatus("disconnected");
  }, []);

  /** SSE 연결 생성 */
  const connect = useCallback(() => {
    if (!sessionKey) return;

    // 기존 연결 정리
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    setStatus("connecting");

    // URL 구성: sessionKey를 인코딩하여 특수문자 안전 보장
    let url = `/api/sessions/${encodeURIComponent(sessionKey)}/events`;
    if (lastEventIdRef.current > 0) {
      url += `?lastEventId=${lastEventIdRef.current}`;
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    // 연결 성공
    es.onopen = () => {
      setStatus("connected");
      reconnectAttemptRef.current = 0;
    };

    // 타입별 이벤트 리스너 등록 (큐를 통해 배치 처리)
    for (const eventType of SSE_EVENT_TYPES) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as SoulSSEEvent;
          const eventId = e.lastEventId ? parseInt(e.lastEventId, 10) : 0;

          enqueueEvent(data, eventId);
        } catch {
          // JSON 파싱 실패: 무시 (keepalive 등)
        }
      });
    }

    // 에러 처리 & 재연결
    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      setStatus("error");

      const attempt = reconnectAttemptRef.current;
      if (autoReconnect && attempt < maxReconnectAttempts) {
        // 지수적 백오프 (상한: maxReconnectIntervalMs)
        const delay = Math.min(
          reconnectIntervalMs * Math.pow(2, attempt),
          maxReconnectIntervalMs,
        );
        reconnectAttemptRef.current = attempt + 1;

        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      } else if (attempt >= maxReconnectAttempts) {
        // 재연결 상한 도달 — 포기
        setStatus("disconnected");
      }
    };
  }, [
    sessionKey,
    autoReconnect,
    reconnectIntervalMs,
    maxReconnectIntervalMs,
    maxReconnectAttempts,
    enqueueEvent,
  ]);

  // sessionKey 변경 시 연결 관리
  useEffect(() => {
    reconnectAttemptRef.current = 0;

    if (sessionKey) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [sessionKey, connect, disconnect]);

  return {
    status,
    connect,
    disconnect,
  };
}
