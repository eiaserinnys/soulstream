/**
 * session-stream-helpers.ts
 *
 * TanStack Query 캐시 업데이트를 위한 순수 함수 모음.
 * SSE 이벤트(session_created/updated/deleted) 수신 시 InfiniteData<SessionPage>를
 * 불변(immutable) 방식으로 변환하는 로직을 컴포넌트 밖으로 분리한다.
 */

import type { InfiniteData } from "@tanstack/react-query";
import type { SessionSummary, CatalogState } from "../shared/types";

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

/**
 * 피드 세션 필터링 + 정렬 순수 함수.
 * Zustand getFeedSessions와 동일한 로직 — 훅/컴포넌트에서 import하여 사용.
 *
 * - llm 세션 제외
 * - excludeFromFeed 폴더 제외 (미분류 세션은 항상 포함)
 * - 24시간 이내 활동한 세션만 포함
 * - updatedAt/createdAt 내림차순 정렬
 */
export function filterFeedSessions(
  sessions: SessionSummary[],
  catalog: CatalogState | null,
): SessionSummary[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return sessions
    .filter((s) => {
      if (s.sessionType === "llm") return false;
      if (catalog) {
        const assignment = catalog.sessions[s.agentSessionId];
        const folderId = assignment?.folderId ?? null;
        if (folderId !== null) {
          const folder = catalog.folders.find((f) => f.id === folderId);
          if (folder?.settings?.excludeFromFeed) return false;
        }
      }
      const t = s.lastMessage?.timestamp ?? s.updatedAt ?? s.createdAt;
      return t != null && new Date(t).getTime() > cutoff;
    })
    .sort((a, b) => {
      const ta = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
      const tb = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
      return tb - ta;
    })
    .map((s) => {
      const assignment = catalog?.sessions[s.agentSessionId];
      if (assignment?.displayName) {
        return { ...s, displayName: assignment.displayName };
      }
      return s;
    });
}

/**
 * session_created 이벤트:
 * filter가 'all'이거나 newSession.sessionType이 filter와 일치할 때
 * pages[0] 앞에 newSession을 prepend한다.
 * filter 불일치 시 data를 그대로 반환한다.
 */
export function applySessionCreated(
  data: InfiniteData<SessionPage>,
  newSession: SessionSummary,
  filter: string,
): InfiniteData<SessionPage> {
  if (filter !== "all" && newSession.sessionType !== filter) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page, i) =>
      i === 0
        ? {
            ...page,
            sessions: [newSession, ...page.sessions],
            total: page.total + 1,
          }
        : page,
    ),
  };
}

/**
 * session_updated 이벤트:
 * 모든 페이지에서 agentSessionId가 일치하는 세션에 updates를 병합한다.
 * 일치하는 세션이 없으면 data를 그대로 반환한다.
 */
export function applySessionUpdated(
  data: InfiniteData<SessionPage>,
  agentSessionId: string,
  updates: Partial<SessionSummary>,
): InfiniteData<SessionPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((s) =>
        s.agentSessionId === agentSessionId ? { ...s, ...updates } : s,
      ),
    })),
  };
}

/**
 * session_deleted 이벤트:
 * 모든 페이지에서 agentSessionId가 일치하는 세션을 제거한다.
 * 일치하는 세션이 없으면 data를 그대로 반환한다.
 */
export function applySessionDeleted(
  data: InfiniteData<SessionPage>,
  agentSessionId: string,
): InfiniteData<SessionPage> {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      sessions: page.sessions.filter(
        (s) => s.agentSessionId !== agentSessionId,
      ),
    })),
  };
}
