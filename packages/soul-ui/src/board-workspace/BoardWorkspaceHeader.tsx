import { BookOpen, ChevronRight, FolderPlus, Plus, RefreshCw, Sparkles, SquarePen, Undo2, Wifi, WifiOff } from "lucide-react";

import type { BoardContainerRef, CatalogFolder } from "../shared/types";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import type { FolderWorkspaceViewMode } from "./folder-workspace-view-mode";
import type { BoardYjsConnectionStatus } from "./board-yjs-client";
import { cn } from "../lib/cn";

interface BoardWorkspaceHeaderProps {
  breadcrumbs: CatalogFolder[];
  selectedFolder: CatalogFolder | null;
  selectedFolderId: string | null;
  boardContainer: BoardContainerRef | null;
  runbookTitle?: string | null;
  runbookStatus?: string | null;
  runbookProgress?: { completed: number; total: number };
  workspaceViewMode?: FolderWorkspaceViewMode;
  connectionStatus: BoardYjsConnectionStatus;
  connectionError?: string | null;
  onWorkspaceViewModeChange?: (mode: FolderWorkspaceViewMode) => void;
  newMenuOpen: boolean;
  onToggleNewMenu: () => void;
  onSelectFolder: (folderId: string) => void;
  canCreateBoardItems?: boolean;
  onCreateFolder: () => void;
  onOpenNewSession: () => void;
  onCreateMarkdown: () => void;
  declutterDisabled?: boolean;
  onDeclutterBoard?: () => void;
  undoDeclutterDisabled?: boolean;
  onUndoDeclutter?: () => void;
}

export function BoardWorkspaceHeader({
  breadcrumbs,
  selectedFolder,
  selectedFolderId,
  boardContainer,
  runbookTitle,
  runbookStatus,
  runbookProgress,
  workspaceViewMode,
  connectionStatus,
  connectionError,
  onWorkspaceViewModeChange,
  newMenuOpen,
  onToggleNewMenu,
  onSelectFolder,
  canCreateBoardItems = true,
  onCreateFolder,
  onOpenNewSession,
  onCreateMarkdown,
  declutterDisabled,
  onDeclutterBoard,
  undoDeclutterDisabled,
  onUndoDeclutter,
}: BoardWorkspaceHeaderProps) {
  const syncStatus = getSyncStatusMeta(connectionStatus);
  const SyncIcon = syncStatus.icon;
  const isRunbookBoard = boardContainer?.kind === "runbook";
  const heading = isRunbookBoard ? runbookTitle ?? "런북 보드" : selectedFolder?.name ?? "워크스페이스";
  const progress = runbookProgress ?? { completed: 0, total: 0 };
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <nav className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/80">
          <span className={cn("min-w-0 truncate", !selectedFolderId && "font-semibold text-muted-foreground")}>
            워크스페이스
          </span>
          {breadcrumbs.map((folder) => (
            <div key={folder.id} className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              <button
                type="button"
                className={cn(
                  "truncate hover:text-foreground",
                  folder.id === selectedFolderId && !isRunbookBoard
                    ? "font-semibold text-muted-foreground"
                    : "text-muted-foreground/80",
                )}
                aria-current={folder.id === selectedFolderId && !isRunbookBoard ? "page" : undefined}
                onClick={() => onSelectFolder(folder.id)}
              >
                {folder.name}
              </button>
            </div>
          ))}
          {isRunbookBoard && (
            <div className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              <span className="min-w-0 truncate font-semibold text-muted-foreground" aria-current="page">
                런북 보드
              </span>
            </div>
          )}
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[22px] font-bold leading-tight text-foreground">
            {heading}
          </h1>
          {isRunbookBoard && (
            <span className="flex min-w-0 shrink-0 items-center gap-1.5">
              <BookOpen className="h-4 w-4 text-accent-blue" aria-hidden="true" />
              {runbookStatus ? (
                <Badge variant="outline" size="sm" className="h-5 px-1.5 text-[10px]">
                  {runbookStatusLabel(runbookStatus)}
                </Badge>
              ) : null}
              <Badge variant="info" size="sm" className="h-5 px-1.5 text-[10px]">
                {progress.completed}/{progress.total}
              </Badge>
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {workspaceViewMode && onWorkspaceViewModeChange && (
          <div className="relative mr-1 flex h-[38px] shrink-0 gap-1 rounded-full border border-glass-border glass-strong glass-shadow-xs p-1">
            {([
              ["list", "폴더"],
              ["board", "보드"],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={cn(
                  "flex h-[30px] items-center rounded-full px-4 text-xs font-semibold transition-colors",
                  workspaceViewMode === mode
                    ? "bg-accent-blue/20 text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_16%)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={workspaceViewMode === mode}
                onClick={() => onWorkspaceViewModeChange(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
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
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndoDeclutter}
          disabled={!onUndoDeclutter || undoDeclutterDisabled}
          title="정리 되돌리기"
          data-testid="board-declutter-undo-button"
        >
          <Undo2 className="mr-1 h-3.5 w-3.5" />
          되돌리기
        </Button>
        {canCreateBoardItems && (
          <>
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
                <div className="absolute right-0 top-full z-20 mt-1 w-36 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1">
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
          </>
        )}
      </div>
    </div>
  );
}

function runbookStatusLabel(status: string): string {
  switch (status) {
    case "open":
    case "active":
      return "진행";
    case "completed":
      return "완료";
    case "cancelled":
      return "취소";
    default:
      return status;
  }
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
