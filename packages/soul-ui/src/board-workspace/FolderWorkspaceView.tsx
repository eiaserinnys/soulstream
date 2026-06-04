import type { SessionSummary } from "../shared/types";
import { FolderContents } from "../components/FolderContents";
import { SessionsTopBar } from "../components/SessionsTopBar";
import type { LoadMoreCallback } from "../components/load-more-guard";
import { useDashboardStore } from "../stores/dashboard-store";
import { BoardWorkspaceView } from "./BoardWorkspaceView";
import { useFolderWorkspaceViewMode } from "./folder-workspace-view-mode";

export interface FolderWorkspaceViewProps {
  sessions?: SessionSummary[];
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<void> | void;
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
}

export function FolderWorkspaceView({
  sessions,
  onMoveSessions,
  onRenameSession,
  onCreateFolder,
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
        onCreateFolder={onCreateFolder}
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
        onLoadMore={onLoadMore}
        hasMore={hasMore}
      />
    </>
  );
}
