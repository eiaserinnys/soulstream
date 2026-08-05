import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useDashboardStore,
  useSessionListProvider,
  type SessionSummary,
  type SessionListStreamEvent,
} from "@seosoyoung/soul-ui";

import { orchestratorSessionProvider } from "../providers";
import { scopeCatalogUpdateToTaskBoardPreservingSessionList } from "./task-board-model";
import {
  projectSessionListSnapshot,
  reconcileCanonicalReviewSessions,
} from "./v3-session-stream-catalog";
import {
  acceptV3SessionStreamEvent,
  invalidateV3,
  trackedV3PageIds,
  useV3PageInvalidationSources,
} from "./v3-live-invalidation-plane";

export function useV3LiveDataPlane({
  sessionIds,
  pageIds,
}: {
  sessionIds: readonly string[];
  pageIds: readonly (string | null | undefined)[];
}) {
  const catalog = useDashboardStore((state) => state.catalog);
  const pendingSessionList = useRef<SessionListStreamEvent | null>(null);
  const pendingReviewSessions = useRef<readonly SessionSummary[] | null>(null);
  const receivedStreamMeta = useRef(false);
  const reviewQueue = useQuery({
    queryKey: ["v3-review-queue", "needs_review"],
    queryFn: () => orchestratorSessionProvider.fetchSessions({
      reviewState: "needs_review",
      limit: 0,
    }),
    staleTime: Infinity,
    gcTime: 0,
  });
  useV3PageInvalidationSources(trackedV3PageIds(pageIds));
  useEffect(() => {
    if (!catalog) return;
    let nextCatalog = catalog;
    if (pendingSessionList.current) {
      nextCatalog = projectSessionListSnapshot(nextCatalog, pendingSessionList.current);
      pendingSessionList.current = null;
    }
    if (pendingReviewSessions.current) {
      nextCatalog = reconcileCanonicalReviewSessions(
        nextCatalog,
        pendingReviewSessions.current,
      );
      pendingReviewSessions.current = null;
    }
    if (nextCatalog !== catalog) useDashboardStore.getState().setCatalog(nextCatalog);
  }, [catalog]);
  useEffect(() => {
    if (!reviewQueue.data) return;
    const state = useDashboardStore.getState();
    if (!state.catalog) {
      pendingReviewSessions.current = reviewQueue.data.sessions;
      return;
    }
    const nextCatalog = reconcileCanonicalReviewSessions(
      state.catalog,
      reviewQueue.data.sessions,
    );
    pendingReviewSessions.current = null;
    if (nextCatalog !== state.catalog) state.setCatalog(nextCatalog);
  }, [reviewQueue.data]);
  return useSessionListProvider({
    enabled: true,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionIds,
    streamEnabled: true,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
    onStreamEvent: (event) => {
      acceptV3SessionStreamEvent(event);
      if (event.type === "stream_meta") {
        if (receivedStreamMeta.current) void reviewQueue.refetch();
        receivedStreamMeta.current = true;
        return;
      }
      if (event.type !== "session_list") return;
      const state = useDashboardStore.getState();
      if (!state.catalog) {
        pendingSessionList.current = event;
        return;
      }
      const nextCatalog = projectSessionListSnapshot(state.catalog, event);
      pendingSessionList.current = null;
      if (nextCatalog !== state.catalog) state.setCatalog(nextCatalog);
    },
    onStreamReset: () => invalidateV3("replay"),
    transformCatalogUpdate: (incoming, current) => {
      const active = useDashboardStore.getState().activeBoardContainer;
      if (!current || active?.kind !== "task") return undefined;
      return scopeCatalogUpdateToTaskBoardPreservingSessionList(current, incoming, active.id);
    },
  });
}
