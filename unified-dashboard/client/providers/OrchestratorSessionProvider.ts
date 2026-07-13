/**
 * OrchestratorSessionProvider - unified-dashboard용 세션 Provider
 *
 * orchestrator-dashboard의 OrchestratorSessionProvider를 unified-dashboard로 포팅.
 * soul-ui SessionStorageProvider 인터페이스를 구현한다.
 *
 * - fetchSessions: /api/sessions 에서 세션 목록 조회 (orchestrator BFF 경로)
 * - fetchCards: SSE 이벤트로 카드를 구성하므로 빈 배열 반환
 * - subscribe: /api/sessions/:key/events SSE 스트림 구독 (히스토리 포함)
 *   → worker EventStore가 히스토리 스트리밍을 처리하므로 SessionCache 불필요
 */

import type {
  SessionStorageProvider,
  SessionListResult,
  FetchSessionsOptions,
  EventTreeNode,
  SoulSSEEvent,
  SessionSummary,
} from "@seosoyoung/soul-ui";
import { buildFetchSessionsUrl, createSSESubscribe, toSessionSummary } from "@seosoyoung/soul-ui";

const MAX_TARGETED_SESSION_URL_LENGTH = 6_000;

export class OrchestratorSessionProvider implements SessionStorageProvider {
  async fetchSessions(options?: FetchSessionsOptions): Promise<SessionListResult> {
    if (options?.sessionIds !== undefined) {
      const sessionIds = [...new Set(options.sessionIds)];
      if (sessionIds.length === 0) return { sessions: [], total: 0, hasMore: false };
      const batches = targetedSessionBatches(sessionIds, options);
      const results = await Promise.all(batches.map((batch) =>
        fetchSessionPage({ ...options, sessionIds: batch, offset: 0, limit: 0 })
      ));
      const sessions = [...new Map(
        results.flatMap((result) => result.sessions)
          .map((session) => [session.agentSessionId, session]),
      ).values()];
      return { sessions, total: sessions.length, hasMore: false };
    }
    return await fetchSessionPage(options);
  }

  async fetchFolderCounts(): Promise<Record<string, number>> {
    try {
      const res = await fetch("/api/sessions/folder-counts");
      if (!res.ok) return {};
      const data: { counts: Record<string, number> } = await res.json();
      return data.counts ?? {};
    } catch {
      return {};
    }
  }

  async fetchCards(_sessionKey: string): Promise<EventTreeNode[]> {
    // SSE 이벤트로 카드를 구성하므로 초기값은 빈 배열
    // 히스토리는 /api/sessions/:key/events SSE 스트림에서 수신 (worker EventStore)
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

async function fetchSessionPage(options?: FetchSessionsOptions): Promise<SessionListResult> {
  const res = await fetch(buildFetchSessionsUrl("/api/sessions", options));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data: {
    sessions?: Array<Record<string, unknown>>;
    sessionList?: Array<Record<string, unknown>>;
    total: number;
  } = await res.json();

  const rows = data.sessions ?? data.sessionList ?? [];
  const sessions = rows.map(toOrchestratorSessionSummary);

  const total = data.total ?? sessions.length;
  const loadedCount = (options?.offset ?? 0) + sessions.length;
  return { sessions, total, hasMore: loadedCount < total };
}

function targetedSessionBatches(
  sessionIds: readonly string[],
  options: FetchSessionsOptions,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  for (const sessionId of sessionIds) {
    const candidate = [...current, sessionId];
    const candidateUrl = buildFetchSessionsUrl("/api/sessions", {
      ...options,
      sessionIds: candidate,
      offset: 0,
      limit: 0,
    });
    if (current.length > 0 && candidateUrl.length > MAX_TARGETED_SESSION_URL_LENGTH) {
      batches.push(current);
      current = [sessionId];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function toOrchestratorSessionSummary(raw: Record<string, unknown>): SessionSummary {
  const summary = toSessionSummary(raw);
  return {
    agentSessionId: summary.agentSessionId,
    status: summary.status,
    reviewRequired: summary.reviewRequired,
    reviewState: summary.reviewState,
    sessionType: (summary.sessionType ?? "claude") as "claude" | "llm",
    eventCount: 0,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt ?? undefined,
    nodeId: summary.nodeId,
    folderId: summary.folderId ?? null,
    displayName: summary.displayName ?? null,
    lastMessage: summary.lastMessage,
    lastEventId: summary.lastEventId ?? 0,
    lastReadEventId: summary.lastReadEventId ?? 0,
    prompt: summary.prompt ?? undefined,
    agentId: summary.agentId ?? undefined,
    agentName: summary.agentName ?? undefined,
    agentPortraitUrl: summary.agentPortraitUrl ?? undefined,
    backend: summary.backend ?? undefined,
    userName: summary.userName ?? undefined,
    userPortraitUrl: summary.userPortraitUrl ?? undefined,
    callerSessionId: summary.callerSessionId ?? undefined,
  };
}

/** OrchestratorSessionProvider 싱글톤 */
export const orchestratorSessionProvider = new OrchestratorSessionProvider();
