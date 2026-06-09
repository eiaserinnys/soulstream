import { ChevronRight, FolderPlus, List, Plus, RefreshCw, Sparkles, SquarePen, Wifi, WifiOff } from "lucide-react";

import type { CatalogFolder } from "../shared/types";
import { Button } from "../components/ui/button";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";
import type { BoardYjsConnectionStatus } from "./board-yjs-client";

interface BoardWorkspaceHeaderProps {
  breadcrumbs: CatalogFolder[];
  selectedFolder: CatalogFolder | null;
  selectedFolderId: string | null;
  workspaceViewMode?: FolderWorkspaceViewMode;
  connectionStatus: BoardYjsConnectionStatus;
  connectionError?: string | null;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
  newMenuOpen: boolean;
  onToggleNewMenu: () => void;
  onSelectFolder: (folderId: string) => void;
  onCreateFolder: () => void;
  onOpenNewSession: () => void;
  onCreateMarkdown: () => void;
  declutterDisabled?: boolean;
  onDeclutterBoard?: () => void;
}

export function BoardWorkspaceHeader({
  breadcrumbs,
  selectedFolder,
  selectedFolderId,
  workspaceViewMode,
  connectionStatus,
  connectionError,
  onWorkspaceViewModeChange,
  newMenuOpen,
  onToggleNewMenu,
  onSelectFolder,
  onCreateFolder,
  onOpenNewSession,
  onCreateMarkdown,
  declutterDisabled,
  onDeclutterBoard,
}: BoardWorkspaceHeaderProps) {
  const syncStatus = getSyncStatusMeta(connectionStatus);
  const SyncIcon = syncStatus.icon;
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1">
        {breadcrumbs.map((folder, index) => (
          <div key={folder.id} className="flex min-w-0 items-center gap-1">
            {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <button
              type="button"
              className={`truncate text-sm font-medium hover:text-foreground ${
                folder.id === selectedFolderId ? "text-foreground" : "text-muted-foreground"
              }`}
              aria-current={folder.id === selectedFolderId ? "page" : undefined}
              onClick={() => onSelectFolder(folder.id)}
            >
              {folder.name}
            </button>
          </div>
        ))}
        {breadcrumbs.length === 0 && (
          <span className="truncate text-sm font-semibold">
            {selectedFolder?.name ?? "Folder"}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span
          data-testid="board-sync-status"
          title={connectionError ?? syncStatus.title}
          className={`inline-flex h-7 max-w-36 items-center gap-1.5 truncate rounded border px-2 text-xs ${syncStatus.className}`}
        >
          <SyncIcon
            className={`h-3.5 w-3.5 shrink-0 ${connectionStatus === "reconnecting" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span className="truncate">{syncStatus.label}</span>
        </span>
        {workspaceViewMode && onWorkspaceViewModeChange && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onWorkspaceViewModeChange("list")}
            title="List view"
          >
            <List className="mr-1 h-3.5 w-3.5" />
            리스트
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDeclutterBoard}
          disabled={!onDeclutterBoard || declutterDisabled}
          title="겹침 정리"
          data-testid="board-declutter-button"
        >
          <Sparkles className="mr-1 h-3.5 w-3.5" />
          정리
        </Button>
        <Button variant="ghost" size="sm" onClick={onCreateFolder} title="New folder">
          <FolderPlus className="mr-1 h-3.5 w-3.5" />
          Folder
        </Button>
        <div className="relative">
          <Button variant="ghost" size="sm" onClick={onToggleNewMenu} title="New">
            <Plus className="mr-1 h-3.5 w-3.5" />
            New
          </Button>
          {newMenuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-md border border-border bg-popover p-1 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={onOpenNewSession}
              >
                <Plus className="h-4 w-4" />
                Session
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={onCreateMarkdown}
              >
                <SquarePen className="h-4 w-4" />
                문서
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getSyncStatusMeta(status: BoardYjsConnectionStatus): {
  icon: typeof Wifi;
  label: string;
  title: string;
  className: string;
} {
  switch (status) {
    case "connected":
      return {
        icon: Wifi,
        label: "동기화됨",
        title: "Board sync connected",
        className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "reconnecting":
      return {
        icon: RefreshCw,
        label: "재연결 중",
        title: "Board sync reconnecting",
        className: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "disconnected":
      return {
        icon: WifiOff,
        label: "연결 끊김",
        title: "Board sync disconnected",
        className: "border-destructive/40 bg-destructive/10 text-destructive",
      };
  }
}
