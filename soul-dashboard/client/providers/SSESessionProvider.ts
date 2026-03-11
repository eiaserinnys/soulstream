/**
 * SSESessionProvider - Soul Server API + SSE 스트림 기반 세션 Provider
 *
 * Soul Server의 /api/sessions 엔드포인트와 SSE 스트림을 통해
 * 세션 목록 조회 및 실시간 이벤트 수신을 처리합니다.
 */

import type {
  SessionStorageProvider,
  StorageMode,
  SessionListResult,
} from "./types";
import type {
  SessionSummary,
  EventTreeNode,
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
  "history_sync",
];

// 주의: complete/error는 "턴" 종료이지 "세션" 종료가 아닙니다.
// 멀티턴 세션(resume)에서는 complete 이후 새 user_message가 올 수 있으므로
// 클라이언트가 임의로 SSE 연결을 끊으면 안 됩니다.
// 연결 해제는 unsubscribe() 또는 서버 종료에 의해서만 수행됩니다.

interface SessionListResponse {
  sessions: Record<string, unknown>[];
  total: number;
}

/**
 * 서버 응답(snake_case)을 SessionSummary(camelCase)로 변환합니다.
 */
function toSessionSummary(raw: Record<string, unknown>): SessionSummary {
  return {
    agentSessionId: (raw.agent_session_id ?? raw.agentSessionId) as string,
    status: (raw.status as SessionSummary["status"]) ?? "unknown",
    eventCount: (raw.event_count ?? raw.eventCount ?? 0) as number,
    createdAt: (raw.created_at ?? raw.createdAt) as string | undefined,
    completedAt: (raw.updated_at ?? raw.completedAt) as string | undefined,
    prompt: raw.prompt as string | undefined,
  };
}

/**
 * Soul Server API + SSE 스트림 기반 세션 Provider.
 *
 * /api/sessions 엔드포인트로 세션 목록을 조회하고,
 * /api/sessions/:id/events SSE 스트림으로 실시간 이벤트를 수신합니다.
 */
export class SSESessionProvider implements SessionStorageProvider {
  readonly mode: StorageMode = "sse";

  /**
   * 세션 목록 조회 (전체 목록 반환).
   *
   * /api/sessions 엔드포인트에서 세션 목록을 가져옵니다.
   * 가상 스크롤이 클라이언트 측에서 렌더링을 제어합니다.
   */
  async fetchSessions(): Promise<SessionListResult> {
    const url = "/api/sessions";

    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data: SessionListResponse = await res.json();
    return {
      sessions: data.sessions.map(toSessionSummary),
      total: data.total,
    };
  }

  /**
   * 세션 카드 목록 조회 (스냅샷).
   *
   * SSE 이벤트를 재생하여 카드를 구성하므로,
   * 초기 스냅샷은 빈 배열을 반환하고 subscribe로 실시간 구축합니다.
   *
   * @param _sessionKey - 세션 키 (agentSessionId)
   */
  async fetchCards(_sessionKey: string): Promise<EventTreeNode[]> {
    // SSE 이벤트로 카드를 구성하므로 초기값은 빈 배열
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
    onEvent: (event: SoulSSEEvent, eventId: number) => void,
    onStatusChange?: (status: "connecting" | "connected" | "error") => void,
  ): () => void {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let lastEventId = 0;
    const maxReconnectAttempts = 20;
    const reconnectIntervalMs = 3000;
    const maxReconnectIntervalMs = 30000;

    const connect = () => {
      if (!sessionKey) return;

      onStatusChange?.("connecting");

      // URL 구성
      let url = `/api/sessions/${encodeURIComponent(sessionKey)}/events`;
      if (lastEventId > 0) {
        url += `?lastEventId=${lastEventId}`;
      }

      const es = new EventSource(url);
      eventSource = es;

      es.onopen = () => {
        reconnectAttempt = 0;
        onStatusChange?.("connected");
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
          } catch {
            // JSON 파싱 실패: 무시
          }
        });
      }

      // 에러 처리 & 재연결
      es.onerror = () => {
        es.close();
        eventSource = null;
        onStatusChange?.("error");

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

/** SSESessionProvider 싱글톤 인스턴스 */
export const sseSessionProvider = new SSESessionProvider();
