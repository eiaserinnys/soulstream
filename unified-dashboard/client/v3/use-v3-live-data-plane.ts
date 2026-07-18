import { useEffect, useRef } from "react";
import {
  useDashboardStore,
  useSessionListProvider,
  type SessionListStreamEvent,
} from "@seosoyoung/soul-ui";

import { orchestratorSessionProvider } from "../providers";
import { scopeCatalogUpdateToTaskBoardPreservingSessionList } from "./task-board-model";
import { projectSessionListSnapshot } from "./v3-session-stream-catalog";
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
  useV3PageInvalidationSources(trackedV3PageIds(pageIds));
  useEffect(() => {
    if (!catalog || !pendingSessionList.current) return;
    const nextCatalog = projectSessionListSnapshot(catalog, pendingSessionList.current);
    pendingSessionList.current = null;
    if (nextCatalog !== catalog) useDashboardStore.getState().setCatalog(nextCatalog);
  }, [catalog]);
  return useSessionListProvider({
    enabled: true,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionIds,
    streamEnabled: true,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
    onStreamEvent: (event) => {
      acceptV3SessionStreamEvent(event);
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
