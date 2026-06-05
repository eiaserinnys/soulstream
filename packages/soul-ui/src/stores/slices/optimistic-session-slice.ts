/**
 * Optimistic Session Slice
 *
 * 세션 생성 직후 즉시 목록에 반영하는 낙관적 prepend 액션.
 * 자체 상태 없음 — 다른 슬라이스(catalog, session, selection, ui) 상태를 cross-slice
 * set()으로 갱신한다 (Zustand 합성 패턴 표준).
 */

import type { StateCreator } from "zustand";
import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import {
  shouldApplySessionCreatedToCache,
  type SessionPage,
} from "../../hooks/session-stream-helpers";
import type { SessionSummary } from "@shared/types";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";
import { clearFlattenTreeCache } from "../../lib/flatten-tree";
import { getSessionResetState } from "./_session-reset";

export type OptimisticSessionSlice = Pick<
  DashboardActions,
  | "addOptimisticSession"
>;

export const createOptimisticSessionSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  OptimisticSessionSlice
> = (set, get) => ({
  addOptimisticSession: (
    queryClient: QueryClient,
    agentSessionId,
    prompt,
    folderId,
    nodeId,
    agentId,
    agentName,
    agentPortraitUrl,
    backend,
    boardPosition,
  ) => {
    let catalog = get().catalog;
    const userConfig = get().dashboardConfig?.user;
    const newSession: SessionSummary = {
      agentSessionId,
      status: "running",
      eventCount: 0,
      createdAt: new Date().toISOString(),
      sessionType: "claude",
      prompt,
      lastEventId: 0,
      lastReadEventId: 0,
      ...(nodeId ? { nodeId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(agentPortraitUrl ? { agentPortraitUrl } : {}),
      ...(backend ? { backend } : {}),
      ...(userConfig?.name && userConfig.name !== "USER" ? { userName: userConfig.name } : {}),
      ...(userConfig?.portraitUrl ? { userPortraitUrl: userConfig.portraitUrl } : {}),
    };

    // TanStack Query 캐시에 낙관적 prepend
    queryClient.setQueriesData<InfiniteData<SessionPage>>(
      {
        queryKey: ["sessions"],
        exact: false,
        predicate: (query) =>
          shouldApplySessionCreatedToCache(
            query.queryKey,
            newSession.sessionType,
            folderId,
            catalog,
          ),
      },
      (old) => {
        if (!old) return old;
        // 이미 존재하면 중복 삽입 방지
        const exists = old.pages.some((page) =>
          page.sessions.some((s) => s.agentSessionId === agentSessionId),
        );
        if (exists) return old;
        return {
          ...old,
          pages: old.pages.map((page, i) =>
            i === 0
              ? {
                  ...page,
                  sessions: [newSession, ...page.sessions],
                  total: page.total + 1,
                }
              : page,
          ),
        };
      },
    );

    // catalog.sessions에도 낙관적으로 폴더 할당 추가
    if (catalog && folderId) {
      catalog = {
        ...catalog,
        sessions: {
          ...catalog.sessions,
          [agentSessionId]: { folderId, displayName: null },
        },
        boardItems: boardPosition
          ? [
              ...(catalog.boardItems ?? []).filter((item) => item.id !== `session:${agentSessionId}`),
              {
                id: `session:${agentSessionId}`,
                folderId,
                itemType: "session",
                itemId: agentSessionId,
                x: boardPosition.x,
                y: boardPosition.y,
              },
            ]
          : catalog.boardItems,
      };
    }

    // 새 세션 진입이므로 ChatMessage identity 캐시를 비운다.
    clearFlattenTreeCache();
    set({
      ...getSessionResetState(),
      catalog,
      activeSessionKey: agentSessionId,
      activeSession: null,
      selectedSessionIds: new Set([agentSessionId]),
      // 새 세션이 생성된 폴더로 뷰를 이동한다.
      // folderId가 undefined이면 호출자가 폴더를 지정하지 않은 것이므로 현재 선택을 유지한다.
      ...(folderId !== undefined
        ? { selectedFolderId: folderId, viewMode: "folder" as const }
        : {}),
    });

    get().setActiveSessionSummary(newSession);
  },
});
