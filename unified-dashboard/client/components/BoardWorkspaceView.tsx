import { useCallback } from "react";
import {
  BoardWorkspaceView as SoulUIBoardWorkspaceView,
  shouldLoadMoreAfterSessionMove,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  createMarkdownDocument,
  updateBoardItemPosition,
} from "client/lib/board-workspace-operations";
import { createFolder } from "client/lib/folder-operations";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

interface BoardWorkspaceViewWrapperProps {
  sessions?: SessionSummary[];
  onLoadMore?: () => Promise<unknown> | void;
  hasMore?: boolean;
}

export function BoardWorkspaceView({
  sessions,
  onLoadMore,
  hasMore,
}: BoardWorkspaceViewWrapperProps = {}) {
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
    <SoulUIBoardWorkspaceView
      sessions={sessions}
      onMoveSessions={handleMoveSessions}
      onRenameSession={renameSessionOptimistic}
      onCreateFolder={createFolder}
      onUpdateBoardItemPosition={updateBoardItemPosition}
      onCreateMarkdownDocument={createMarkdownDocument}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}
