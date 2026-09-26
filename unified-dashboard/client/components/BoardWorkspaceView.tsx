import { useCallback } from "react";
import {
  BoardWorkspaceView as SoulUIBoardWorkspaceView,
  shouldLoadMoreAfterSessionMove,
  useDashboardStore,
  useRenameSessionOperation,
} from "@seosoyoung/soul-ui";
import type { BoardContainerRef, CatalogBoardItem, CatalogState, SessionSummary } from "@seosoyoung/soul-ui";

import {
  createFolder,
  deleteFolderOptimistic,
  renameFolderOptimistic,
  updateFolderSettingsOptimistic,
} from "client/lib/folder-operations";
import { deleteSessions } from "client/lib/delete-session";
import { moveSessionsOptimistic } from "client/lib/move-sessions";
import { renameSessionOperation } from "client/lib/rename-session";
import {
  moveBoardItemToContainer,
  uploadBoardAsset,
} from "client/lib/board-workspace-operations";
import { useContinueSession } from "client/hooks/useContinueSession";

interface BoardWorkspaceViewWrapperProps {
  catalogOverride?: CatalogState | null;
  boardContainerOverride?: BoardContainerRef | null;
  selectedFolderIdOverride?: string | null;
  sessions?: SessionSummary[];
  taskMoveTargets?: ReadonlyArray<{ id: string; title: string }>;
  onBoardItemMoved?: (boardItem: CatalogBoardItem) => void;
  onMarkdownDocumentDeleted?: (documentId: string, boardItemId: string) => void;
  onOpenMarkdownDocument?: (documentId: string) => void;
  onRequestMarkdownEdit?: (documentId: string) => void;
  onOpenCustomView?: (customViewId: string) => void;
  onLoadMore?: () => Promise<unknown> | void;
  hasMore?: boolean;
  viewportPersistenceKey?: string | null;
}

export function BoardWorkspaceView({
  catalogOverride,
  boardContainerOverride,
  selectedFolderIdOverride,
  sessions,
  taskMoveTargets,
  onBoardItemMoved,
  onMarkdownDocumentDeleted,
  onOpenMarkdownDocument,
  onRequestMarkdownEdit,
  onOpenCustomView,
  onLoadMore,
  hasMore,
  viewportPersistenceKey,
}: BoardWorkspaceViewWrapperProps = {}) {
  const viewMode = useDashboardStore((s) => s.viewMode);
  const storedSelectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectedFolderId = selectedFolderIdOverride === undefined
    ? storedSelectedFolderId
    : selectedFolderIdOverride;
  const storedCatalog = useDashboardStore((s) => s.catalog);
  const catalog = catalogOverride === undefined ? storedCatalog : catalogOverride;
  const renameSession = useRenameSessionOperation(renameSessionOperation);
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
    <SoulUIBoardWorkspaceView
      catalogOverride={catalogOverride}
      boardContainerOverride={boardContainerOverride}
      selectedFolderIdOverride={selectedFolderIdOverride}
      sessions={sessions}
      taskMoveTargets={taskMoveTargets}
      onBoardItemMoved={onBoardItemMoved}
      onMarkdownDocumentDeleted={onMarkdownDocumentDeleted}
      onOpenMarkdownDocument={onOpenMarkdownDocument}
      onRequestMarkdownEdit={onRequestMarkdownEdit}
      onOpenCustomView={onOpenCustomView}
      onMoveSessions={handleMoveSessions}
      onRenameSession={renameSession}
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
      viewportPersistenceKey={viewportPersistenceKey}
    />
  );
}
