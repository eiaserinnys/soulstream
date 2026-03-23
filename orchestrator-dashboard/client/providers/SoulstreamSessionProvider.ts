/**
 * SoulstreamSessionProvider — 오케스트레이터 대시보드용 SessionStorageProvider 구현.
 *
 * SoulStream API를 통해 특정 노드의 세션에 접근한다.
 * 개별 세션의 이벤트는 노드의 소울 서버에 프록시되는
 * /api/sessions/:id/events SSE 엔드포인트를 사용한다.
 */

import type {
  SessionStorageProvider,
  StorageMode,
  SessionListResult,
} from "@seosoyoung/soul-ui";
import type { EventTreeNode, SoulSSEEvent, SSEEventType } from "@seosoyoung/soul-ui";

/**
 * SSE 이벤트 타입 목록.
 * 서버가 `event: text_start` 같은 typed event를 보내므로,
 * EventSource.onmessage가 아닌 addEventListener(type, ...)로 수신해야 한다.
 */
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
  "history_sync",
];

export class SoulstreamSessionProvider implements SessionStorageProvider {
  readonly mode: StorageMode = "sse";

  async fetchSessions(_sessionType?: string): Promise<SessionListResult> {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
    const data = await res.json();
    return {
      sessions: data.sessions ?? [],
      total: data.total ?? 0,
    };
  }

  async fetchCards(_sessionKey: string): Promise<EventTreeNode[]> {
    // SoulStream은 세션의 카드(이벤트 트리)를 직접 제공하지 않으므로
    // SSE 스트림에서 증분으로 빌드한다.
    return [];
  }

  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void,
    onStatusChange?: (status: "connecting" | "connected" | "error") => void,
    options?: { lastEventId?: number },
  ): () => void {
    onStatusChange?.("connecting");

    let url = `/api/sessions/${sessionKey}/events`;
    if (options?.lastEventId !== undefined) {
      url += `?after_id=${options.lastEventId}`;
    }

    const es = new EventSource(url);

    es.onopen = () => {
      onStatusChange?.("connected");
    };

    for (const eventType of SSE_EVENT_TYPES) {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as SoulSSEEvent;
          const eventId = e.lastEventId ? parseInt(e.lastEventId, 10) : 0;
          onEvent(data, eventId);
        } catch {
          // JSON 파싱 실패: 무시
        }
      });
    }

    es.onerror = (e) => {
      // 서버가 보낸 named "error" 이벤트는 MessageEvent로 도착.
      if (e instanceof MessageEvent) return;
      onStatusChange?.("error");
    };

    return () => {
      es.close();
    };
  }
}
