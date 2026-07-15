import { useDashboardStore, useSessionListProvider } from "@seosoyoung/soul-ui";

import { orchestratorSessionProvider } from "../providers";
import { scopeCatalogUpdateToTaskBoard } from "./task-board-model";
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
  useV3PageInvalidationSources(trackedV3PageIds(pageIds));
  return useSessionListProvider({
    enabled: true,
    getSessionProvider: () => orchestratorSessionProvider,
    sessionIds,
    streamEnabled: true,
    initialCatalogLoadEnabled: false,
    folderCountsEnabled: false,
    onStreamEvent: acceptV3SessionStreamEvent,
    onStreamReset: () => invalidateV3("replay"),
    transformCatalogUpdate: (incoming, current) => {
      const active = useDashboardStore.getState().activeBoardContainer;
      if (!current || active?.kind !== "runbook") return undefined;
      return scopeCatalogUpdateToTaskBoard(current, incoming, active.id);
    },
  });
}
