/**
 * SessionsTopBar - 세션 목록 상단 바
 *
 * 'Sessions' 제목과 'New' 버튼을 표시한다.
 * New 클릭 시 NewSessionModal을 연다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import { Button } from "./ui/button";
import { ChevronRight, Plus, Settings } from "lucide-react";
import type { FolderWorkspaceViewMode } from "../board-workspace/folder-workspace-view-mode";
import { getFolderBreadcrumbs } from "../board-workspace/board-workspace-helpers";
import { cn } from "../lib/cn";

export interface SessionsTopBarProps {
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
  onOpenFolderSettings?: () => void;
}

export function SessionsTopBar({
  workspaceViewMode,
  onWorkspaceViewModeChange,
  onOpenFolderSettings,
}: SessionsTopBarProps = {}) {
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const catalog = useDashboardStore((s) => s.catalog);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const canToggleWorkspace = Boolean(workspaceViewMode && onWorkspaceViewModeChange);
  const folders = catalog?.folders ?? [];
  const breadcrumbs = getFolderBreadcrumbs(folders, selectedFolderId);
  const selectedFolder = selectedFolderId
    ? folders.find((folder) => folder.id === selectedFolderId) ?? null
    : null;
  const currentName = selectedFolder?.name ?? "워크스페이스";
  const activeMode = workspaceViewMode ?? "list";

  return (
    <div className="shrink-0 px-4 pb-3 pt-3">
      <nav className="flex min-w-0 items-center gap-1.5 px-1 pb-1.5 text-xs text-muted-foreground/80">
        <button
          type="button"
          className={cn(
            "min-w-0 truncate hover:text-foreground",
            !selectedFolderId && "font-semibold text-muted-foreground",
          )}
          aria-current={!selectedFolderId ? "page" : undefined}
          onClick={() => selectFolder(null)}
        >
          워크스페이스
        </button>
        {breadcrumbs.map((folder) => (
          <div key={folder.id} className="flex min-w-0 items-center gap-1.5">
            <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            <button
              type="button"
              className={cn(
                "min-w-0 truncate hover:text-foreground",
                folder.id === selectedFolderId && "font-semibold text-muted-foreground",
              )}
              aria-current={folder.id === selectedFolderId ? "page" : undefined}
              onClick={() => selectFolder(folder.id)}
            >
              {folder.name}
            </button>
          </div>
        ))}
      </nav>
      <div className="flex min-w-0 items-center gap-3 px-1">
        <h1 className="min-w-0 truncate text-[22px] font-bold leading-tight text-foreground">
          {currentName}
        </h1>
        {selectedFolder && onOpenFolderSettings && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-full"
            aria-label={`${selectedFolder.name} 폴더 설정`}
            title="폴더 설정"
            onClick={onOpenFolderSettings}
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        {canToggleWorkspace && (
          <div className="relative flex h-[38px] shrink-0 gap-1 rounded-full border border-glass-border glass-strong glass-shadow-xs p-1">
            {([
              ["list", "폴더"],
              ["board", "보드"],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  "flex h-[30px] items-center rounded-full px-4 text-xs font-semibold transition-colors",
                  activeMode === mode
                    ? "bg-accent-blue/20 text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_16%)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={activeMode === mode}
                onClick={() => onWorkspaceViewModeChange?.(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <Button
          size="sm"
          onClick={() => openNewSessionModal('folder')}
          title="New session"
          className="ml-auto h-[38px] rounded-full px-4"
        >
          <Plus className="h-3.5 w-3.5" />
          새 세션
        </Button>
      </div>
    </div>
  );
}
