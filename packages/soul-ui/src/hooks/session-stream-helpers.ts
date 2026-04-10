/**
 * session-stream-helpers.ts
 *
 * TanStack Query 캐시 업데이트를 위한 순수 함수 모음.
 * SSE 이벤트(session_created/updated/deleted) 수신 시 InfiniteData<SessionPage>를
 * 불변(immutable) 방식으로 변환하는 로직을 컴포넌트 밖으로 분리한다.
 */

import type { InfiniteData } from "@tanstack/react-query";
import type { SessionSummary } from "../shared/types";

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
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
