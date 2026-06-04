import { useMemo, useState } from "react";
import { ChevronRight, Folder, FolderPlus, List, Plus } from "lucide-react";

import { useDashboardStore } from "../stores/dashboard-store";
import type { SessionSummary } from "../shared/types";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { FolderDialog } from "../components/FolderDialog";
import type { LoadMoreCallback } from "../components/load-more-guard";
import { useIsMobile } from "../hooks/use-mobile";
import { cn } from "../lib/cn";
import { applyCatalogDisplayNames } from "../hooks/session-stream-helpers";
import { STATUS_CONFIG } from "../components/SessionItem";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";
import {
  buildBoardWorkspaceItems,
  formatBoardWorkspaceTime,
  getSessionBoardPreview,
  getSessionBoardTitle,
} from "./board-workspace-items";

import {
  getFolderBreadcrumbs,
} from "./board-workspace-helpers";

const EMPTY_SESSIONS: SessionSummary[] = [];

export interface BoardWorkspaceViewProps {
  sessions?: SessionSummary[];
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onCreateFolder?: (name: string, parentFolderId: string | null) => Promise<void> | void;
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
}

export function BoardWorkspaceView({
  sessions = EMPTY_SESSIONS,
  onCreateFolder,
  onLoadMore,
  hasMore,
  workspaceViewMode,
  onWorkspaceViewModeChange,
}: BoardWorkspaceViewProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const setActiveSession = useDashboardStore((s) => s.setActiveSession);
  const setActiveSessionSummary = useDashboardStore((s) => s.setActiveSessionSummary);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const isMobile = useIsMobile();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const folders = catalog?.folders ?? [];
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const displaySessions = useMemo(() => {
    return applyCatalogDisplayNames(sessions, catalog);
  }, [sessions, catalog]);

  const breadcrumbs = useMemo(
    () => getFolderBreadcrumbs(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  const boardItems = useMemo(() => {
    if (!catalog) return [];
    return buildBoardWorkspaceItems({
      catalog,
      selectedFolderId,
      sessions: displaySessions,
    });
  }, [catalog, selectedFolderId, displaySessions]);

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
          {workspaceViewMode && onWorkspaceViewModeChange && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onWorkspaceViewModeChange("list")}
              title="List view"
            >
              <List className="h-3.5 w-3.5 mr-1" />
              리스트
            </Button>
          )}
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

      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {boardItems.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No folders or sessions on this board
          </div>
        ) : (
          <div
            data-testid="board-workspace-grid"
            className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2"
          >
            {boardItems.map((item) => {
              if (item.type === "folder") {
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid="board-folder-tile"
                    className="flex min-h-28 flex-col justify-between rounded-md border border-border px-3 py-2 text-left hover:bg-accent/50"
                    onClick={() => selectFolder(item.folder.id)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Folder className="h-5 w-5 shrink-0 text-primary" />
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {item.childCount}
                      </Badge>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{item.folder.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatBoardWorkspaceTime(item.folder.createdAt)}
                      </div>
                    </div>
                  </button>
                );
              }

              const config = STATUS_CONFIG[item.session.status] ?? STATUS_CONFIG.unknown;
              const activityTime =
                item.session.lastMessage?.timestamp ?? item.session.updatedAt ?? item.session.createdAt;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid="board-session-tile"
                  data-session-id={item.session.agentSessionId}
                  className={cn(
                    "flex min-h-28 flex-col justify-between rounded-md border border-border px-3 py-2 text-left hover:bg-accent/50",
                    activeSessionKey === item.session.agentSessionId && "bg-accent text-accent-foreground",
                  )}
                  onClick={() => {
                    setActiveSession(item.session.agentSessionId);
                    setActiveSessionSummary(item.session);
                    if (isMobile) setActiveTab("chat");
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        config.dotClass,
                        config.animate && "animate-[pulse_2s_infinite]",
                      )}
                    />
                    <span className="min-w-0 truncate text-sm font-medium">
                      {getSessionBoardTitle(item.session)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-xs text-muted-foreground">
                      {getSessionBoardPreview(item.session)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatBoardWorkspaceTime(activityTime)}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {hasMore && onLoadMore && (
          <div className="flex justify-center py-3">
            <Button variant="ghost" size="sm" onClick={() => onLoadMore()}>
              Load more
            </Button>
          </div>
        )}
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
