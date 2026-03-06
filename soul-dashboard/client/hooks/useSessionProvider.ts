/**
 * useSessionProvider - Provider 기반 세션 상세 훅
 *
 * 현재 스토리지 모드에 따라 적절한 Provider를 사용하여
 * 세션 상세 정보와 실시간 업데이트를 처리합니다.
 */

import { useEffect, useState, useCallback } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { getSessionProvider } from "../providers";

interface UseSessionProviderOptions {
  /** 구독할 세션 키. null이면 구독 안 함 */
  sessionKey: string | null;
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export function useSessionProvider(options: UseSessionProviderOptions) {
  const { sessionKey } = options;

  const storageMode = useDashboardStore((s) => s.storageMode);
  const processEvent = useDashboardStore((s) => s.processEvent);
  const clearTree = useDashboardStore((s) => s.clearTree);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

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
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          // 텍스트 카드
          if (card.type === "text") {
            processEvent(
              {
                type: "text_start",
                timestamp: 0,
              },
              i * 2
            );
            processEvent(
              {
                type: "text_delta",
                timestamp: 0,
                text: card.content,
              },
              i * 2 + 1
            );
            processEvent(
              {
                type: "text_end",
                timestamp: 0,
              },
              i * 2 + 2
            );
          }
          // 도구 카드
          else if (card.type === "tool") {
            processEvent(
              {
                type: "tool_start",
                timestamp: 0,
                tool_name: card.toolName,
                tool_input: card.toolInput,
                tool_use_id: card.toolUseId,
                parent_event_id: card.parentEventId,
              },
              i * 2
            );
            if (card.completed) {
              processEvent(
                {
                  type: "tool_result",
                  timestamp: 0,
                  tool_name: card.toolName,
                  result: card.toolResult ?? "",
                  is_error: card.isError ?? false,
                  tool_use_id: card.toolUseId,
                  parent_event_id: card.parentEventId,
                },
                i * 2 + 1
              );
            }
          }
        }

        setStatus("connected");
      } catch (err) {
        console.error("[useSessionProvider] Failed to load initial cards:", err);
        setStatus("error");
      }
    };

    loadInitialCards();

    // 실시간 구독 (SSE 재연결 시 상태 피드백 포함)
    const unsubscribe = provider.subscribe(
      sessionKey,
      (event, eventId) => {
        processEvent(event, eventId);
      },
      setStatus,
    );

    return () => {
      unsubscribe();
      setStatus("disconnected");
    };
  }, [sessionKey, storageMode, processEvent, clearTree]);

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
