/**
 * FolderContents - soul-ui FolderContents 래퍼 (unified-dashboard)
 *
 * soul-ui의 FolderContents에 unified-dashboard API 구현을 주입한다.
 */

import { useCallback } from "react";
import {
  FolderContents as SoulUIFolderContents,
  shouldLoadMoreAfterSessionMove,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import type { SessionSummary } from "@seosoyoung/soul-ui";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

interface FolderContentsWrapperProps {
  sessions?: SessionSummary[];
  onLoadMore?: () => Promise<unknown> | void;
  hasMore?: boolean;
}

export function FolderContents({ sessions, onLoadMore, hasMore }: FolderContentsWrapperProps = {}) {
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);

  const handleMoveSessions = useCallback(
    async (sessionIds: string[], targetFolderId: string | null) => {
      const shouldBackfill = shouldLoadMoreAfterSessionMove({
        viewMode,
        selectedFolderId,
        catalog,
        sessionIds,
        targetFolderId,
      });
      await moveSessionsOptimistic(sessionIds, targetFolderId);
      if (hasMore && onLoadMore && shouldBackfill) {
        onLoadMore();
      }
    },
    [catalog, hasMore, onLoadMore, selectedFolderId, viewMode],
  );

  return (
    <SoulUIFolderContents
      sessions={sessions}
      onMoveSessions={handleMoveSessions}
      onRenameSession={renameSessionOptimistic}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}
