import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderPlus, Plus } from "lucide-react";

import { useDashboardStore } from "../stores/dashboard-store";
import type { SessionSummary } from "../shared/types";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { FolderDialog } from "../components/FolderDialog";
import { FolderContents } from "../components/FolderContents";
import type { LoadMoreCallback } from "../components/load-more-guard";

import {
  getChildFolders,
  getFolderBreadcrumbs,
  getFolderDirectChildCount,
} from "./board-workspace-helpers";

export interface BoardWorkspaceViewProps {
  sessions?: SessionSummary[];
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<void> | void;
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
}

export function BoardWorkspaceView({
  sessions,
  onMoveSessions,
  onRenameSession,
  onCreateFolder,
  onLoadMore,
  hasMore,
}: BoardWorkspaceViewProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const folders = catalog?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;

  const breadcrumbs = useMemo(
    () => getFolderBreadcrumbs(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const childFolders = useMemo(
    () => getChildFolders(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const handleCreateFolder = async (name: string) => {
    await onCreateFolder?.(name.trim(), selectedFolderId);
    setCreateDialogOpen(false);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          {breadcrumbs.map((folder, index) => (
            <div key={folder.id} className="flex items-center gap-1 min-w-0">
              {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
              <button
                type="button"
                className={`text-sm font-medium truncate hover:text-foreground ${
                  folder.id === selectedFolderId ? "text-foreground" : "text-muted-foreground"
                }`}
                aria-current={folder.id === selectedFolderId ? "page" : undefined}
                onClick={() => selectFolder(folder.id)}
              >
                {folder.name}
              </button>
            </div>
          ))}
          {breadcrumbs.length === 0 && (
            <span className="text-sm font-semibold truncate">
              {selectedFolder?.name ?? "Folder"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCreateDialogOpen(true)}
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5 mr-1" />
            Folder
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openNewSessionModal("folder")}
            title="New session"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            New
          </Button>
        </div>
      </div>

      {catalog && childFolders.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 p-3 border-b border-border shrink-0">
          {childFolders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="flex items-center gap-2 min-h-14 rounded-md border border-border px-3 py-2 text-left hover:bg-accent/50"
              onClick={() => selectFolder(folder.id)}
            >
              <Folder className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>
              <Badge variant="secondary" className="shrink-0 text-xs">
                {getFolderDirectChildCount(catalog, folder.id)}
              </Badge>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <FolderContents
          sessions={sessions}
          onMoveSessions={onMoveSessions}
          onRenameSession={onRenameSession}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
        />
      </div>

      <FolderDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onConfirm={handleCreateFolder}
      />
    </div>
  );
}
