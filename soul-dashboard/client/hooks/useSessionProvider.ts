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
  const clearCards = useDashboardStore((s) => s.clearCards);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");

  // 세션 변경 시 카드 초기화 및 구독 시작
  useEffect(() => {
    if (!sessionKey) {
      setStatus("disconnected");
      return;
    }

    // 카드 초기화
    clearCards();
    setStatus("connecting");

    const provider = getSessionProvider(storageMode);

    // 초기 카드 로드 (Serendipity 모드에서 필요)
    const loadInitialCards = async () => {
      try {
        const cards = await provider.fetchCards(sessionKey);

        // 각 카드를 이벤트로 변환하여 처리
        // (File 모드에서는 빈 배열이므로 영향 없음)
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          // 텍스트 카드
          if (card.type === "text") {
            processEvent(
              {
                type: "text_start",
                card_id: card.cardId,
              },
              i * 2
            );
            processEvent(
              {
                type: "text_delta",
                card_id: card.cardId,
                text: card.content,
              },
              i * 2 + 1
            );
            processEvent(
              {
                type: "text_end",
                card_id: card.cardId,
              },
              i * 2 + 2
            );
          }
          // 도구 카드
          else if (card.type === "tool") {
            processEvent(
              {
                type: "tool_start",
                card_id: card.parentCardId,
                tool_name: card.toolName ?? "unknown",
                tool_input: card.toolInput ?? {},
                tool_use_id: card.toolUseId,
              },
              i * 2
            );
            if (card.completed) {
              processEvent(
                {
                  type: "tool_result",
                  card_id: card.parentCardId,
                  tool_name: card.toolName ?? "unknown",
                  result: card.toolResult ?? "",
                  is_error: card.isError ?? false,
                  tool_use_id: card.toolUseId,
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

    // 실시간 구독
    const unsubscribe = provider.subscribe(sessionKey, (event, eventId) => {
      processEvent(event, eventId);
    });

    return () => {
      unsubscribe();
      setStatus("disconnected");
    };
  }, [sessionKey, storageMode, processEvent, clearCards]);

  const reconnect = useCallback(() => {
    // 재연결은 sessionKey 변경으로 트리거됨
    // 여기서는 수동 재연결을 위해 상태만 초기화
    if (sessionKey) {
      clearCards();
    }
  }, [sessionKey, clearCards]);

  return {
    status,
    reconnect,
    storageMode,
  };
}
