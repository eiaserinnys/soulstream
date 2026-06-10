import type { CatalogFolder, FolderSettings, SessionSummary } from "../shared/types";
import { FolderContents } from "../components/FolderContents";
import { SessionsTopBar } from "../components/SessionsTopBar";
import type { LoadMoreCallback } from "../components/load-more-guard";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  BoardWorkspaceView,
  type BoardWorkspaceViewProps,
  type CreateMarkdownDocumentInput,
  type CreateMarkdownDocumentResult,
} from "./BoardWorkspaceView";
import { useFolderWorkspaceViewMode } from "./folder-workspace-view-mode";

export interface FolderWorkspaceViewProps {
  sessions?: SessionSummary[];
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onDeleteSessions?: (sessionIds: string[]) => Promise<void>;
  onContinueSession?: (sessionId: string) => Promise<void>;
  getContinueSessionDisabledReason?: (sessionId: string) => string | null;
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<CatalogFolder | void> | CatalogFolder | void;
  onRenameFolder?: (folderId: string, name: string) => Promise<void> | void;
  onDeleteFolder?: (folderId: string) => Promise<void> | void;
  onUpdateFolderSettings?: (folderId: string, settings: FolderSettings) => Promise<void> | void;
  onUpdateBoardItemPosition?: (boardItemId: string, x: number, y: number) => Promise<void> | void;
  onCreateMarkdownDocument?: (
    input: CreateMarkdownDocumentInput,
  ) => Promise<CreateMarkdownDocumentResult>;
  onUploadBoardAsset?: BoardWorkspaceViewProps["onUploadBoardAsset"];
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
}

export function FolderWorkspaceView({
  sessions,
  onMoveSessions,
  onRenameSession,
  onDeleteSessions,
  onContinueSession,
  getContinueSessionDisabledReason,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  onUpdateBoardItemPosition,
  onCreateMarkdownDocument,
  onUploadBoardAsset,
  onLoadMore,
  hasMore,
}: FolderWorkspaceViewProps) {
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const [workspaceViewMode, setWorkspaceViewMode] =
    useFolderWorkspaceViewMode(selectedFolderId);

  if (workspaceViewMode === "board") {
    return (
      <BoardWorkspaceView
        sessions={sessions}
        onMoveSessions={onMoveSessions}
        onRenameSession={onRenameSession}
        onDeleteSessions={onDeleteSessions}
        onContinueSession={onContinueSession}
        getContinueSessionDisabledReason={getContinueSessionDisabledReason}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onUpdateFolderSettings={onUpdateFolderSettings}
        onUpdateBoardItemPosition={onUpdateBoardItemPosition}
        onCreateMarkdownDocument={onCreateMarkdownDocument}
        onUploadBoardAsset={onUploadBoardAsset}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        workspaceViewMode={workspaceViewMode}
        onWorkspaceViewModeChange={setWorkspaceViewMode}
      />
    );
  }

  return (
    <>
      <SessionsTopBar
        workspaceViewMode={workspaceViewMode}
        onWorkspaceViewModeChange={setWorkspaceViewMode}
      />
      <FolderContents
        sessions={sessions}
        onMoveSessions={onMoveSessions}
        onRenameSession={onRenameSession}
        onContinueSession={onContinueSession}
        getContinueSessionDisabledReason={getContinueSessionDisabledReason}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
      />
    </>
  );
}
