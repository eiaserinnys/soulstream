/**
 * FileSessionProvider - JSONL 파일 기반 세션 Provider
 *
 * 기존 Soul 대시보드의 파일 기반 세션 관리 로직을 Provider 인터페이스로 추상화.
 * SSE 스트림을 통한 실시간 업데이트를 지원합니다.
 */

import type {
  SessionStorageProvider,
  StorageMode,
} from "./types";
import type {
  SessionSummary,
  DashboardCard,
  SoulSSEEvent,
  SSEEventType,
} from "@shared/types";

// SSE 이벤트 타입 목록
const SSE_EVENT_TYPES: SSEEventType[] = [
  "progress",
  "memory",
  "session",
  "intervention_sent",
  "user_message",
  "debug",
  "complete",
  "error",
  "text_start",
  "text_delta",
  "text_end",
  "tool_start",
  "tool_result",
  "result",
  "context_usage",
  "compact",
  "reconnect",
];

/** 세션 종료 이벤트 타입 */
const TERMINAL_EVENTS = new Set<string>(["complete", "error"]);

interface SessionListResponse {
  sessions: SessionSummary[];
}

/**
 * JSONL 파일 + SSE 스트림 기반 세션 Provider.
 *
 * 기존 Soul 대시보드의 /api/sessions 엔드포인트를 활용합니다.
 */
export class FileSessionProvider implements SessionStorageProvider {
  readonly mode: StorageMode = "file";

  /**
   * 세션 목록 조회.
   *
   * /api/sessions 엔드포인트에서 세션 목록을 가져옵니다.
   */
  async fetchSessions(): Promise<SessionSummary[]> {
    const res = await fetch("/api/sessions");

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data: SessionListResponse = await res.json();
    return data.sessions;
  }

  /**
   * 세션 카드 목록 조회 (스냅샷).
   *
   * File 모드에서는 SSE 이벤트를 재생하여 카드를 구성하므로,
   * 초기 스냅샷은 빈 배열을 반환하고 subscribe로 실시간 구축합니다.
   *
   * @param _sessionKey - 세션 키 (agentSessionId)
   */
  async fetchCards(_sessionKey: string): Promise<DashboardCard[]> {
    // File 모드는 SSE 이벤트로 카드를 구성하므로 초기값은 빈 배열
    // 실제 이벤트 히스토리가 필요하면 /api/sessions/:id/events?history=true 호출 가능
    return [];
  }

  /**
   * SSE 스트림 구독.
   *
   * /api/sessions/:sessionKey/events SSE 스트림을 구독하여
   * 실시간 이벤트를 수신합니다.
   *
   * @param sessionKey - 세션 키 (agentSessionId)
   * @param onEvent - 이벤트 수신 콜백
   * @returns 구독 해제 함수
   */
  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void
  ): () => void {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let lastEventId = 0;
    let isTerminal = false;

    const maxReconnectAttempts = 20;
    const reconnectIntervalMs = 3000;
    const maxReconnectIntervalMs = 30000;

    const connect = () => {
      if (!sessionKey || isTerminal) return;

      // URL 구성
      let url = `/api/sessions/${encodeURIComponent(sessionKey)}/events`;
      if (lastEventId > 0) {
        url += `?lastEventId=${lastEventId}`;
      }

      const es = new EventSource(url);
      eventSource = es;

      es.onopen = () => {
        reconnectAttempt = 0;
      };

      // 타입별 이벤트 리스너 등록
      for (const eventType of SSE_EVENT_TYPES) {
        es.addEventListener(eventType, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as SoulSSEEvent;
            const eventId = e.lastEventId ? parseInt(e.lastEventId, 10) : 0;

            if (eventId > lastEventId) {
              lastEventId = eventId;
            }

            onEvent(data, eventId);

            // 터미널 이벤트면 연결 종료
            if (TERMINAL_EVENTS.has(eventType)) {
              isTerminal = true;
              es.close();
              eventSource = null;
            }
          } catch {
            // JSON 파싱 실패: 무시
          }
        });
      }

      // 에러 처리 & 재연결
      es.onerror = () => {
        es.close();
        eventSource = null;

        if (isTerminal) return;

        const attempt = reconnectAttempt;
        if (attempt < maxReconnectAttempts) {
          const delay = Math.min(
            reconnectIntervalMs * Math.pow(2, attempt),
            maxReconnectIntervalMs
          );
          reconnectAttempt = attempt + 1;

          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
        }
      };
    };

    // 초기 연결
    connect();

    // 구독 해제 함수
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
}

/** FileSessionProvider 싱글톤 인스턴스 */
export const fileSessionProvider = new FileSessionProvider();
