import { useCallback } from "react";
import {
  FolderWorkspaceView as SoulUIFolderWorkspaceView,
  shouldLoadMoreAfterSessionMove,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  createMarkdownDocument,
  updateBoardItemPosition,
} from "client/lib/board-workspace-operations";
import {
  createFolder,
  deleteFolderOptimistic,
  renameFolderOptimistic,
  updateFolderSettingsOptimistic,
} from "client/lib/folder-operations";
import { deleteSessions } from "client/lib/delete-session";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";

interface FolderWorkspaceViewWrapperProps {
  sessions?: SessionSummary[];
  onLoadMore?: () => Promise<unknown> | void;
  hasMore?: boolean;
}

export function FolderWorkspaceView({
  sessions,
  onLoadMore,
  hasMore,
}: FolderWorkspaceViewWrapperProps = {}) {
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
    <SoulUIFolderWorkspaceView
      sessions={sessions}
      onMoveSessions={handleMoveSessions}
      onRenameSession={renameSessionOptimistic}
      onDeleteSessions={deleteSessions}
      onCreateFolder={createFolder}
      onRenameFolder={renameFolderOptimistic}
      onDeleteFolder={deleteFolderOptimistic}
      onUpdateFolderSettings={updateFolderSettingsOptimistic}
      onUpdateBoardItemPosition={updateBoardItemPosition}
      onCreateMarkdownDocument={createMarkdownDocument}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}
