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
  FetchSessionsOptions,
} from "./types";
import type { EventTreeNode, SoulSSEEvent } from "@shared/types";
import { toSessionSummary } from "@shared/mappers";
import { createSSESubscribe } from "./sse-subscribe";

// 주의: complete/error는 "턴" 종료이지 "세션" 종료가 아닙니다.
// 멀티턴 세션(resume)에서는 complete 이후 새 user_message가 올 수 있으므로
// 클라이언트가 임의로 SSE 연결을 끊으면 안 됩니다.
// 연결 해제는 unsubscribe() 또는 서버 종료에 의해서만 수행됩니다.

// createSSESubscribe가 이 의미를 준수한다:
// complete/error 이벤트가 와도 연결을 유지하며, unsubscribe() 호출 시에만 종료한다.

interface SessionListResponse {
  sessions: Record<string, unknown>[];
  total: number;
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
   * 세션 목록 조회 (페이지네이션 지원).
   *
   * /api/sessions 엔드포인트에서 세션 목록을 가져옵니다.
   * offset/limit으로 페이지 범위를 지정합니다.
   */
  async fetchSessions(options?: FetchSessionsOptions): Promise<SessionListResult> {
    const params = new URLSearchParams();
    if (options?.sessionType) params.set("session_type", options.sessionType);
    if (options?.offset != null && options.offset > 0) params.set("offset", String(options.offset));
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.folderId) params.set("folder_id", options.folderId);
    const qs = params.toString();
    const url = `/api/sessions${qs ? `?${qs}` : ""}`;

    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data: SessionListResponse = await res.json();
    const loadedCount = (options?.offset ?? 0) + data.sessions.length;
    return {
      sessions: data.sessions.map(toSessionSummary),
      total: data.total,
      hasMore: loadedCount < data.total,
    };
  }

  /**
   * 폴더별 세션 수 조회.
   *
   * /api/sessions/folder-counts 엔드포인트에서 집계값을 가져옵니다.
   */
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
    options?: { lastEventId?: number },
  ): () => void {
    return createSSESubscribe({
      baseUrl: `/api/sessions/${encodeURIComponent(sessionKey)}/events`,
      onEvent,
      onStatusChange,
      initialLastEventId: options?.lastEventId,
    });
  }
}

/** SSESessionProvider 싱글톤 인스턴스 */
export const sseSessionProvider = new SSESessionProvider();
