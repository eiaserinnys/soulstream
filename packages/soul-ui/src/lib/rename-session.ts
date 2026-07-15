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

export function createRenameSessionOperation(config: RenameSessionApiConfig): RenameSessionOperations {
  const method = config.method ?? "PUT";

  async function renameSessionOptimistic(
    sessionId: string,
    displayName: string | null,
    options: RenameSessionOptimisticOptions = {},
  ): Promise<void> {
    const { renameSession, catalog } = useDashboardStore.getState();
    const prevDisplayName = catalog?.sessions[sessionId]?.displayName ?? null;
    const querySnapshots = options.queryClient?.getQueriesData<InfiniteData<SessionPage>>({
      queryKey: ["sessions"],
      exact: false,
    }) ?? [];

    renameSession(sessionId, displayName);
    updateSessionQueryNames(options.queryClient, sessionId, displayName);

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
      for (const [queryKey, snapshot] of querySnapshots) {
        options.queryClient?.setQueryData(queryKey, snapshot);
      }
      console.error("Session rename failed, rolled back:", err);
      throw err;
    }
  }

  return { renameSessionOptimistic };
}

function updateSessionQueryNames(
  queryClient: QueryClient | undefined,
  sessionId: string,
  displayName: string | null,
): void {
  queryClient?.setQueriesData<InfiniteData<SessionPage>>(
    { queryKey: ["sessions"], exact: false },
    (current) => current ? {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        sessions: page.sessions.map((session) => session.agentSessionId === sessionId
          ? { ...session, displayName }
          : session),
      })),
    } : current,
  );
}

const defaultRenameOperation = createRenameSessionOperation({
  url: (sessionId) => `/api/sessions/${sessionId}/display-name`,
  method: "PATCH",
});

// soul-dashboard 전용 기본 인스턴스 (worker API 경로)
export const renameSessionOptimistic = defaultRenameOperation.renameSessionOptimistic;
