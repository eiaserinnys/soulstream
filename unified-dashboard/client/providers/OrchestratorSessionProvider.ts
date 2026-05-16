/**
 * OrchestratorSessionProvider - unified-dashboard용 세션 Provider
 *
 * orchestrator-dashboard의 OrchestratorSessionProvider를 unified-dashboard로 포팅.
 * soul-ui SessionStorageProvider 인터페이스를 구현한다.
 *
 * - fetchSessions: /api/catalog 에서 세션 목록 조회 (orchestrator BFF 경로)
 * - fetchCards: SSE 이벤트로 카드를 구성하므로 빈 배열 반환
 * - subscribe: /api/sessions/:key/events SSE 스트림 구독 (히스토리 포함)
 *   → soul-server EventStore가 히스토리 스트리밍을 처리하므로 SessionCache 불필요
 */

import type {
  SessionStorageProvider,
  SessionListResult,
  FetchSessionsOptions,
  EventTreeNode,
  SoulSSEEvent,
  SessionStatus,
} from "@seosoyoung/soul-ui";
import { createSSESubscribe } from "@seosoyoung/soul-ui";

export class OrchestratorSessionProvider implements SessionStorageProvider {
  async fetchSessions(options?: FetchSessionsOptions): Promise<SessionListResult> {
    const params = new URLSearchParams();
    if (options?.sessionType) params.set("session_type", options.sessionType);
    if (options?.offset != null && options.offset > 0) params.set("offset", String(options.offset));
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.folderId) params.set("folder_id", options.folderId);
    if (options?.feedOnly) params.set("feed_only", "true");
    const qs = params.toString();
    const res = await fetch(`/api/catalog${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Phase A-bis(2026-05-16): catalog sessionList가 _session_to_response 정본
    // helper로 통일됨 — 응답 키는 camelCase. backend 키 신규 박힘(R1, 본 fix 목적).
    const data: {
      sessionList: Array<{
        agentSessionId: string;
        status: string;
        prompt?: string | null;
        createdAt: string;
        updatedAt: string | null;
        sessionType: string | null;
        lastMessage: {
          preview: string;
          timestamp: string;
          type: string;
        } | null;
        clientId?: string | null;
        metadata?: unknown;
        displayName: string | null;
        nodeId: string;
        folderId: string | null;
        lastEventId: number | null;
        lastReadEventId: number | null;
        callerSessionId?: string | null;
        agentId?: string | null;
        agentName?: string | null;
        agentPortraitUrl?: string | null;
        backend?: string | null;
        userName?: string | null;
        userPortraitUrl?: string | null;
      }>;
      total: number;
    } = await res.json();

    const sessions = data.sessionList.map((s) => ({
      agentSessionId: s.agentSessionId,
      status: mapStatus(s.status),
      sessionType: (s.sessionType ?? "claude") as "claude" | "llm",
      eventCount: 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt ?? undefined,
      nodeId: s.nodeId,
      displayName: s.displayName ?? undefined,
      lastMessage: s.lastMessage ?? undefined,
      lastEventId: s.lastEventId ?? 0,
      lastReadEventId: s.lastReadEventId ?? 0,
      prompt: s.prompt ?? undefined,
      agentId: s.agentId ?? undefined,
      agentName: s.agentName ?? undefined,
      agentPortraitUrl: s.agentPortraitUrl ?? undefined,
      backend: s.backend ?? undefined,
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
    const debugPrefix =
      import.meta.env.VITE_SSE_DEBUG === "true"
        ? `[OrchestratorSSE][${sessionKey.slice(0, 12)}]`
        : undefined;

    return createSSESubscribe({
      baseUrl: `/api/sessions/${encodeURIComponent(sessionKey)}/events`,
      onEvent,
      onStatusChange,
      initialLastEventId: options?.lastEventId,
      debugPrefix,
    });
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
