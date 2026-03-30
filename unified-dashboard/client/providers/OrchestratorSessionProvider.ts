/**
 * OrchestratorSessionProvider - orchestrator 모드용 세션 Provider (unified-dashboard)
 *
 * orchestrator-dashboard의 OrchestratorSessionProvider를 unified-dashboard로 포팅.
 * soul-ui SessionStorageProvider 인터페이스를 구현하여
 * getSessionProvider 팩토리에서 orchestrator 모드일 때 반환된다.
 *
 * - fetchSessions: /api/catalog 에서 세션 목록 조회 (orchestrator BFF 경로)
 * - fetchCards: SSE 이벤트로 카드를 구성하므로 빈 배열 반환
 * - subscribe: /api/sessions/:key/events SSE 스트림 구독 (히스토리 포함)
 *   → soul-server EventStore가 히스토리 스트리밍을 처리하므로 SessionCache 불필요
 */

import type {
  SessionStorageProvider,
  StorageMode,
  SessionListResult,
  FetchSessionsOptions,
  EventTreeNode,
  SoulSSEEvent,
  SessionStatus,
} from "@seosoyoung/soul-ui";
import { SSE_EVENT_TYPES } from "@seosoyoung/soul-ui";

export class OrchestratorSessionProvider implements SessionStorageProvider {
  readonly mode: StorageMode = "sse";

  async fetchSessions(options?: FetchSessionsOptions): Promise<SessionListResult> {
    const params = new URLSearchParams();
    if (options?.sessionType) params.set("session_type", options.sessionType);
    if (options?.offset != null && options.offset > 0) params.set("offset", String(options.offset));
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.folderId) params.set("folder_id", options.folderId);
    const qs = params.toString();
    const res = await fetch(`/api/catalog${qs ? `?${qs}` : ""}`);
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
        userName?: string | null;
        userPortraitUrl?: string | null;
      }>;
      total: number;
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
      userName: s.userName ?? undefined,
      userPortraitUrl: s.userPortraitUrl ?? undefined,
    }));

    const total = data.total ?? sessions.length;
    const loadedCount = (options?.offset ?? 0) + sessions.length;
    return { sessions, total, hasMore: loadedCount < total };
  }

  async fetchFolderCounts(): Promise<Record<string, number>> {
    try {
      const res = await fetch("/api/catalog/folder-counts");
      if (!res.ok) return {};
      const data: { counts: Record<string, number> } = await res.json();
      return data.counts ?? {};
    } catch {
      return {};
    }
  }

  async fetchCards(_sessionKey: string): Promise<EventTreeNode[]> {
    // SSE 이벤트로 카드를 구성하므로 초기값은 빈 배열
    // 히스토리는 /api/sessions/:key/events SSE 스트림에서 수신 (soul-server EventStore)
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

    const debug = import.meta.env.VITE_SSE_DEBUG === "true";
    const log = debug
      ? (...args: unknown[]) =>
          console.log(`[OrchestratorSSE][${sessionKey.slice(0, 12)}]`, ...args)
      : () => {};

    const connect = () => {
      if (!sessionKey) return;

      onStatusChange?.("connecting");

      let url = `/api/sessions/${encodeURIComponent(sessionKey)}/events`;
      if (lastEventId > 0) {
        url += `?lastEventId=${lastEventId}`;
      }

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
            if (eventId > lastEventId) lastEventId = eventId;
            log(`event type=${eventType} id=${eventId}`, data);
            onEvent(data, eventId);
          } catch (err) {
            log(`JSON parse error on type=${eventType}`, err);
          }
        });
      }

      es.onerror = (e) => {
        // Named "error" event from server is a MessageEvent — not a connection error
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
