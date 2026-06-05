import { ChevronRight, FolderPlus, List, Plus, SquarePen } from "lucide-react";

import type { CatalogFolder } from "../shared/types";
import { Button } from "../components/ui/button";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";

interface BoardWorkspaceHeaderProps {
  breadcrumbs: CatalogFolder[];
  selectedFolder: CatalogFolder | null;
  selectedFolderId: string | null;
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
  newMenuOpen: boolean;
  onToggleNewMenu: () => void;
  onSelectFolder: (folderId: string) => void;
  onCreateFolder: () => void;
  onOpenNewSession: () => void;
  onCreateMarkdown: () => void;
}

export function BoardWorkspaceHeader({
  breadcrumbs,
  selectedFolder,
  selectedFolderId,
  workspaceViewMode,
  onWorkspaceViewModeChange,
  newMenuOpen,
  onToggleNewMenu,
  onSelectFolder,
  onCreateFolder,
  onOpenNewSession,
  onCreateMarkdown,
}: BoardWorkspaceHeaderProps) {
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
