/**
 * OrchestratorSessionProvider - orchestrator BFF API 기반 세션 Provider.
 *
 * soul-ui SessionStorageProvider 인터페이스를 구현하여
 * DashboardLayout의 getSessionProvider / externalProvider로 주입된다.
 *
 * - fetchSessions: /api/catalog 에서 세션 목록 조회
 * - fetchCards: SSE 이벤트로 카드를 구성하므로 빈 배열 반환
 * - subscribe: /api/sessions/:key/events SSE 스트림 구독
 */

import type {
  SessionStorageProvider,
  StorageMode,
  SessionListResult,
  EventTreeNode,
  SoulSSEEvent,
  SessionStatus,
} from "@seosoyoung/soul-ui";
import { SSE_EVENT_TYPES } from "@seosoyoung/soul-ui";

export class OrchestratorSessionProvider implements SessionStorageProvider {
  readonly mode: StorageMode = "sse";

  async fetchSessions(_sessionType?: string): Promise<SessionListResult> {
    const res = await fetch("/api/catalog");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data: {
      sessionList: Array<{
        session_id: string;
        node_id: string;
        folder_id: string | null;
        display_name: string | null;
        last_message: {
          preview: string;
          timestamp: string;
          type: string;
        } | null;
        status: string;
        session_type: string | null;
        created_at: string;
        updated_at: string | null;
        last_event_id: number | null;
        last_read_event_id: number | null;
        prompt?: string | null;
        agent_id?: string | null;
        agentName?: string | null;
        agentPortraitUrl?: string | null;
      }>;
    } = await res.json();

    const sessions = data.sessionList.map((s) => ({
      agentSessionId: s.session_id,
      status: mapStatus(s.status),
      sessionType: (s.session_type ?? "claude") as "claude" | "llm",
      eventCount: 0,
      createdAt: s.created_at,
      updatedAt: s.updated_at ?? undefined,
      nodeId: s.node_id,
      displayName: s.display_name ?? undefined,
      lastMessage: s.last_message ?? undefined,
      lastEventId: s.last_event_id ?? 0,
      lastReadEventId: s.last_read_event_id ?? 0,
      prompt: s.prompt ?? undefined,
      agentId: s.agent_id ?? undefined,
      agentName: s.agentName ?? undefined,
      agentPortraitUrl: s.agentPortraitUrl ?? undefined,
    }));

    return { sessions, total: sessions.length };
  }

  async fetchCards(_sessionKey: string): Promise<EventTreeNode[]> {
    // SSE 이벤트로 카드를 구성하므로 초기값은 빈 배열
    return [];
  }

  subscribe(
    sessionKey: string,
    onEvent: (event: SoulSSEEvent, eventId: number) => void,
    onStatusChange?: (status: "connecting" | "connected" | "error") => void,
    options?: { lastEventId?: number },
  ): () => void {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let lastEventId = options?.lastEventId ?? 0;
    const maxReconnectAttempts = 20;
    const reconnectIntervalMs = 3000;
    const maxReconnectIntervalMs = 30000;

    const connect = () => {
      if (!sessionKey) return;

      onStatusChange?.("connecting");

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

      for (const eventType of SSE_EVENT_TYPES) {
        es.addEventListener(eventType, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as SoulSSEEvent;
            const eventId = e.lastEventId ? parseInt(e.lastEventId, 10) : 0;
            if (eventId > lastEventId) lastEventId = eventId;
            onEvent(data, eventId);
          } catch {
            // JSON parse error: ignore
          }
        });
      }

      es.onerror = (e) => {
        // Named "error" event from server is a MessageEvent — not a connection error
        if (e instanceof MessageEvent) return;

        es.close();
        eventSource = null;
        onStatusChange?.("error");

        if (reconnectAttempt < maxReconnectAttempts) {
          const delay = Math.min(
            reconnectIntervalMs * Math.pow(2, reconnectAttempt),
            maxReconnectIntervalMs,
          );
          reconnectAttempt++;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, delay);
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
}

function mapStatus(status: string): SessionStatus {
  switch (status) {
    case "running": return "running";
    case "completed": return "completed";
    case "error": return "error";
    default: return "unknown";
  }
}

/** OrchestratorSessionProvider 싱글톤 */
export const orchestratorSessionProvider = new OrchestratorSessionProvider();
