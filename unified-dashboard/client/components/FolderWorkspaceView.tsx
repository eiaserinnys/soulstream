import { useCallback } from "react";
import {
  FolderWorkspaceView as SoulUIFolderWorkspaceView,
  shouldLoadMoreAfterSessionMove,
  useDashboardStore,
} from "@seosoyoung/soul-ui";
import type { SessionSummary } from "@seosoyoung/soul-ui";

import {
  createFolder,
  deleteFolderOptimistic,
  renameFolderOptimistic,
  updateFolderSettingsOptimistic,
} from "client/lib/folder-operations";
import { deleteSessions } from "client/lib/delete-session";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOptimistic } from "client/lib/rename-session";
import {
  moveBoardItemToContainer,
  uploadBoardAsset,
} from "client/lib/board-workspace-operations";
import { useContinueSession } from "client/hooks/useContinueSession";

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
  const { continueSession, getContinueSessionDisabledReason } = useContinueSession(sessions);

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
      onContinueSession={continueSession}
      getContinueSessionDisabledReason={getContinueSessionDisabledReason}
      onCreateFolder={createFolder}
      onRenameFolder={renameFolderOptimistic}
      onDeleteFolder={deleteFolderOptimistic}
      onUpdateFolderSettings={updateFolderSettingsOptimistic}
      onMoveBoardItemToContainer={moveBoardItemToContainer}
      onUploadBoardAsset={uploadBoardAsset}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
    />
  );
}
