import {
  BoardWorkspaceView as SoulUIBoardWorkspaceView,
} from "@seosoyoung/soul-ui";
import type { BoardContainerRef, CatalogBoardItem, CatalogState, SessionSummary } from "@seosoyoung/soul-ui";

import {
  createFolder,
  archiveFolder,
  renameFolderOptimistic,
  updateFolderSettingsOptimistic,
} from "client/lib/folder-operations";
import {
  moveBoardItemToFolder,
  uploadBoardAsset,
} from "client/lib/board-workspace-operations";

interface BoardWorkspaceViewWrapperProps {
  catalogOverride?: CatalogState | null;
  boardContainerOverride?: BoardContainerRef | null;
  selectedFolderIdOverride?: string | null;
  sessions?: SessionSummary[];
  folderMoveTargets?: ReadonlyArray<{ id: string; title: string }>;
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
  folderMoveTargets,
  onBoardItemMoved,
  onMarkdownDocumentDeleted,
  onOpenMarkdownDocument,
  onRequestMarkdownEdit,
  onOpenCustomView,
  onLoadMore,
  hasMore,
  viewportPersistenceKey,
}: BoardWorkspaceViewWrapperProps = {}) {
  return (
    <SoulUIBoardWorkspaceView
      catalogOverride={catalogOverride}
      boardContainerOverride={boardContainerOverride}
      selectedFolderIdOverride={selectedFolderIdOverride}
      sessions={sessions}
      folderMoveTargets={folderMoveTargets}
      onBoardItemMoved={onBoardItemMoved}
      onMarkdownDocumentDeleted={onMarkdownDocumentDeleted}
      onOpenMarkdownDocument={onOpenMarkdownDocument}
      onRequestMarkdownEdit={onRequestMarkdownEdit}
      onOpenCustomView={onOpenCustomView}
      onCreateFolder={createFolder}
      onRenameFolder={renameFolderOptimistic}
      onDeleteFolder={archiveFolder}
      onUpdateFolderSettings={updateFolderSettingsOptimistic}
      onMoveBoardItemToFolder={moveBoardItemToFolder}
      onUploadBoardAsset={uploadBoardAsset}
      onLoadMore={onLoadMore}
      hasMore={hasMore}
      viewportPersistenceKey={viewportPersistenceKey}
    />
  );
}
