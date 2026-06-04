/**
 * SessionsTopBar - 세션 목록 상단 바
 *
 * 'Sessions' 제목과 'New' 버튼을 표시한다.
 * New 클릭 시 NewSessionModal을 연다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import { Button } from "./ui/button";
import { Grid2X2, List, Plus } from "lucide-react";
import type { FolderWorkspaceViewMode } from "../board-workspace/folder-workspace-view-mode";

export interface SessionsTopBarProps {
  workspaceViewMode?: FolderWorkspaceViewMode;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
}

export function SessionsTopBar({
  workspaceViewMode,
  onWorkspaceViewModeChange,
}: SessionsTopBarProps = {}) {
  const openNewSessionModal = useDashboardStore((s) => s.openNewSessionModal);
  const canToggleWorkspace = Boolean(workspaceViewMode && onWorkspaceViewModeChange);
  const nextWorkspaceMode: FolderWorkspaceViewMode =
    workspaceViewMode === "board" ? "list" : "board";

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
      <span className="text-sm font-semibold">Sessions</span>
      <div className="flex items-center gap-1">
        {canToggleWorkspace && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onWorkspaceViewModeChange?.(nextWorkspaceMode)}
            title={nextWorkspaceMode === "board" ? "Board view" : "List view"}
          >
            {nextWorkspaceMode === "board" ? (
              <Grid2X2 className="h-3.5 w-3.5 mr-1" />
            ) : (
              <List className="h-3.5 w-3.5 mr-1" />
            )}
            {nextWorkspaceMode === "board" ? "보드" : "리스트"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openNewSessionModal('folder')}
          title="New session"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          New
        </Button>
      </div>
    </div>
  );
}
