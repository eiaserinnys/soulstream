/**
 * useSessionProvider - Provider 기반 세션 상세 훅
 *
 * 현재 스토리지 모드에 따라 적절한 Provider를 사용하여
 * 세션 상세 정보와 실시간 업데이트를 처리합니다.
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getSessionProvider } from "../providers";
import type { SoulSSEEvent } from "@shared/types";

interface UseSessionProviderOptions {
  /** 구독할 세션 키. null이면 구독 안 함 */
  sessionKey: string | null;
}

import { BATCH_SIZE, BATCH_FLUSH_MS } from "../lib/event-batch";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

interface QueuedEvent {
  event: SoulSSEEvent;
  eventId: number;
}

export function useSessionProvider(options: UseSessionProviderOptions) {
  const { sessionKey } = options;

  const storageMode = useDashboardStore((s) => s.storageMode);
  const processEvents = useDashboardStore((s) => s.processEvents);
  const clearTree = useDashboardStore((s) => s.clearTree);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  // 이벤트 큐 + 타이머 refs
  const eventQueueRef = useRef<QueuedEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processEventsRef = useRef(processEvents);

  // stale closure 방지
  useEffect(() => {
    processEventsRef.current = processEvents;
  }, [processEvents]);

  /** 큐를 청크 단위로 처리, 청크 간 yielding */
  const drainQueue = useCallback(() => {
    const queue = eventQueueRef.current;
    if (queue.length === 0) return;

    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const chunk = queue.splice(0, BATCH_SIZE);
    processEventsRef.current(chunk);

    if (queue.length > 0) {
      drainTimerRef.current = setTimeout(() => {
        drainTimerRef.current = null;
        drainQueue();
      }, 0);
    }
  }, []);

  /** 이벤트를 큐에 추가 */
  const enqueueEvent = useCallback(
    (event: SoulSSEEvent, eventId: number) => {
      eventQueueRef.current.push({ event, eventId });

      if (eventQueueRef.current.length >= BATCH_SIZE) {
        drainQueue();
        return;
      }

      if (!flushTimerRef.current && !drainTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          drainQueue();
        }, BATCH_FLUSH_MS);
      }
    },
    [drainQueue],
  );

  /** 타이머 정리 + 잔여 이벤트 폐기 (세션 전환 시 직후 clearTree()가 호출되므로 flush 불필요) */
  const clearTimersAndQueue = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (drainTimerRef.current) {
      clearTimeout(drainTimerRef.current);
      drainTimerRef.current = null;
    }
    eventQueueRef.current.length = 0;
  }, []);

  // 세션 변경 시 카드 초기화 및 구독 시작
  useEffect(() => {
    if (!sessionKey) {
      setStatus("disconnected");
      return;
    }

    // 카드 초기화
    clearTree();
    setStatus("connecting");

    const provider = getSessionProvider(storageMode);

    // 초기 카드 로드 (Serendipity 모드에서 필요, SSE 모드에서는 빈 배열)
    const loadInitialCards = async () => {
      try {
        const cards = await provider.fetchCards(sessionKey);
        // 배치로 처리: 모든 카드 이벤트를 모아서 processEvents 1회 호출
        const batch: QueuedEvent[] = [];
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          if (card.type === "text") {
            batch.push({ event: { type: "text_start", timestamp: 0 }, eventId: i * 3 });
            batch.push({ event: { type: "text_delta", timestamp: 0, text: card.content }, eventId: i * 3 + 1 });
            batch.push({ event: { type: "text_end", timestamp: 0 }, eventId: i * 3 + 2 });
          } else if (card.type === "tool") {
            batch.push({
              event: {
                type: "tool_start",
                timestamp: 0,
                tool_name: card.toolName,
                tool_input: card.toolInput,
                tool_use_id: card.toolUseId,
                parent_event_id: card.parentEventId,
              },
              eventId: i * 3,
            });
            if (card.completed) {
              batch.push({
                event: {
                  type: "tool_result",
                  timestamp: 0,
                  tool_name: card.toolName,
                  result: card.toolResult ?? "",
                  is_error: card.isError ?? false,
                  tool_use_id: card.toolUseId,
                  parent_event_id: card.parentEventId,
                },
                eventId: i * 3 + 1,
              });
            }
          }
        }
        if (batch.length > 0) {
          processEvents(batch);
        }

        setStatus("connected");
      } catch (err) {
        console.error("[useSessionProvider] Failed to load initial cards:", err);
        setStatus("error");
      }
    };

    loadInitialCards();

    // 실시간 구독 — 이벤트를 큐에 버퍼링하여 배치 처리
    const unsubscribe = provider.subscribe(
      sessionKey,
      (event, eventId) => {
        enqueueEvent(event, eventId);
      },
      setStatus,
    );

    return () => {
      clearTimersAndQueue();
      unsubscribe();
      setStatus("disconnected");
    };
  }, [sessionKey, storageMode, processEvents, clearTree, enqueueEvent, clearTimersAndQueue]);

  const reconnect = useCallback(() => {
    // 재연결은 sessionKey 변경으로 트리거됨
    // 여기서는 수동 재연결을 위해 상태만 초기화
    if (sessionKey) {
      clearTree();
    }
  }, [sessionKey, clearTree]);

  return {
    status,
    reconnect,
    storageMode,
  };
}
