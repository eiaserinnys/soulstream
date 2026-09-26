/**
 * 세션 이름 변경 낙관적 업데이트 팩토리
 *
 * API 경로를 config 객체로 주입받아, soul-dashboard와 orchestrator-dashboard
 * 모두에서 사용할 수 있는 세션 이름 변경 함수를 생성합니다.
 */

import {
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";

export interface RenameSessionApiConfig {
  /** 세션 ID를 받아 URL을 반환하는 함수 */
  url: (sessionId: string) => string;
  method?: "PUT" | "PATCH";
}

export interface RenameSessionOperations {
  renameSessionOptimistic: (
    sessionId: string,
    displayName: string | null,
    options?: RenameSessionOptimisticOptions,
  ) => Promise<void>;
}

export interface RenameSessionOptimisticOptions {
  queryClient?: QueryClient;
}

interface SessionPage {
  sessions: SessionSummary[];
  total: number;
}

interface ReviewQueueResult {
  sessions: SessionSummary[];
  total: number;
  hasMore?: boolean;
}

export function createRenameSessionOperation(config: RenameSessionApiConfig): RenameSessionOperations {
  const method = config.method ?? "PUT";

  async function renameSessionOptimistic(
    sessionId: string,
    displayName: string | null,
    options: RenameSessionOptimisticOptions = {},
  ): Promise<void> {
    const storeState = useDashboardStore.getState();
    const { renameSession, catalog } = storeState;
    const prevDisplayName = catalog?.sessions[sessionId]?.displayName ?? null;
    const prevCatalogSummary = catalog?.sessionList?.find(
      (session) => session.agentSessionId === sessionId,
    );
    const prevActiveSummary = storeState.activeSessionSummary?.agentSessionId === sessionId
      ? storeState.activeSessionSummary
      : undefined;
    const querySnapshots = options.queryClient?.getQueriesData<InfiniteData<SessionPage>>({
      queryKey: ["sessions"],
      exact: false,
    }) ?? [];
    const reviewQueueSnapshots = options.queryClient?.getQueriesData<ReviewQueueResult>({
      queryKey: ["v3-review-queue"],
      exact: false,
    }) ?? [];

    updateStoreSessionDisplayName(sessionId, displayName);
    updateSessionQueryNames(options.queryClient, sessionId, displayName);
    updateReviewQueueDisplayName(options.queryClient, sessionId, displayName);

    try {
      const res = await fetch(config.url(sessionId), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
    } catch (err) {
      // 롤백
      renameSession(sessionId, prevDisplayName);
      restoreStoreSessionDisplayName(sessionId, prevCatalogSummary, prevActiveSummary);
      for (const [queryKey, snapshot] of querySnapshots) {
        options.queryClient?.setQueryData(queryKey, snapshot);
      }
      for (const [queryKey, snapshot] of reviewQueueSnapshots) {
        options.queryClient?.setQueryData(queryKey, snapshot);
      }
      console.error("Session rename failed, rolled back:", err);
      throw err;
    }
  }

  return { renameSessionOptimistic };
}

function updateStoreSessionDisplayName(
  sessionId: string,
  displayName: string | null,
): void {
  useDashboardStore.getState().renameSession(sessionId, displayName);
  const state = useDashboardStore.getState();
  if (state.catalog?.sessionList) {
    const sessionList = updateSessionSummaryName(
      state.catalog.sessionList,
      sessionId,
      displayName,
    );
    if (sessionList !== state.catalog.sessionList) {
      state.setCatalog({ ...state.catalog, sessionList });
    }
  }
  const activeSummary = state.activeSessionSummary;
  if (activeSummary?.agentSessionId === sessionId && activeSummary.displayName !== displayName) {
    state.setActiveSessionSummary({ ...activeSummary, displayName });
  }
}

function restoreStoreSessionDisplayName(
  sessionId: string,
  previousCatalogSummary: SessionSummary | undefined,
  previousActiveSummary: SessionSummary | undefined,
): void {
  const state = useDashboardStore.getState();
  if (previousCatalogSummary && state.catalog?.sessionList) {
    const sessionList = restoreSessionSummaryName(
      state.catalog.sessionList,
      sessionId,
      previousCatalogSummary,
    );
    if (sessionList !== state.catalog.sessionList) {
      state.setCatalog({ ...state.catalog, sessionList });
    }
  }
  const activeSummary = state.activeSessionSummary;
  if (previousActiveSummary && activeSummary?.agentSessionId === sessionId) {
    const restored = restoreDisplayName(activeSummary, previousActiveSummary);
    if (restored !== activeSummary) state.setActiveSessionSummary(restored);
  }
}

function updateSessionQueryNames(
  queryClient: QueryClient | undefined,
  sessionId: string,
  displayName: string | null,
): void {
  queryClient?.setQueriesData<InfiniteData<SessionPage>>(
    { queryKey: ["sessions"], exact: false },
    (current) => {
      if (!current) return current;
      const pages = current.pages.map((page) => {
        const sessions = updateSessionSummaryName(page.sessions, sessionId, displayName);
        return sessions === page.sessions ? page : { ...page, sessions };
      });
      return pages.every((page, index) => page === current.pages[index])
        ? current
        : { ...current, pages };
    },
  );
}

function updateReviewQueueDisplayName(
  queryClient: QueryClient | undefined,
  sessionId: string,
  displayName: string | null,
): void {
  queryClient?.setQueriesData<ReviewQueueResult>(
    { queryKey: ["v3-review-queue"], exact: false },
    (current) => {
      if (!current) return current;
      const sessions = updateSessionSummaryName(current.sessions, sessionId, displayName);
      return sessions === current.sessions ? current : { ...current, sessions };
    },
  );
}

function updateSessionSummaryName(
  sessions: SessionSummary[],
  sessionId: string,
  displayName: string | null,
): SessionSummary[] {
  let changed = false;
  const updated = sessions.map((session) => {
    if (session.agentSessionId !== sessionId || session.displayName === displayName) {
      return session;
    }
    changed = true;
    return { ...session, displayName };
  });
  return changed ? updated : sessions;
}

function restoreSessionSummaryName(
  sessions: SessionSummary[],
  sessionId: string,
  previous: SessionSummary,
): SessionSummary[] {
  let changed = false;
  const restored = sessions.map((session) => {
    if (session.agentSessionId !== sessionId) return session;
    const result = restoreDisplayName(session, previous);
    if (result !== session) changed = true;
    return result;
  });
  return changed ? restored : sessions;
}

function restoreDisplayName<T extends SessionSummary>(
  current: T,
  previous: SessionSummary,
): T {
  if (current.displayName === previous.displayName) return current;
  if (previous.displayName === undefined) {
    const { displayName: _displayName, ...withoutDisplayName } = current;
    return withoutDisplayName as T;
  }
  return { ...current, displayName: previous.displayName };
}

const defaultRenameOperation = createRenameSessionOperation({
  url: (sessionId) => `/api/sessions/${sessionId}/display-name`,
  method: "PATCH",
});

// soul-dashboard 전용 기본 인스턴스 (worker API 경로)
export const renameSessionOptimistic = defaultRenameOperation.renameSessionOptimistic;
