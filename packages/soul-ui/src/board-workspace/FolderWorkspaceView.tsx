import type { CatalogFolder, FolderSettings, SessionSummary } from "../shared/types";
import { useMemo, useState } from "react";
import { FolderContents } from "../components/FolderContents";
import { FolderSettingsDialog } from "../components/FolderSettingsDialog";
import { SessionsTopBar } from "../components/SessionsTopBar";
import type { LoadMoreCallback } from "../components/load-more-guard";
import { DASHBOARD_ITEM_GAP_PX, DASHBOARD_PANEL_INSET_PX } from "../components/dashboard-spacing";
import { useDashboardStore } from "../stores/dashboard-store";
import {
  BoardWorkspaceView,
  type BoardWorkspaceViewProps,
  type CreateMarkdownDocumentInput,
  type CreateMarkdownDocumentResult,
} from "./BoardWorkspaceView";
import { getChildFolders, getFolderDirectChildCount } from "./board-workspace-helpers";
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
  const catalog = useDashboardStore((s) => s.catalog);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const [workspaceViewMode, setWorkspaceViewMode] =
    useFolderWorkspaceViewMode(selectedFolderId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const folders = catalog?.folders ?? [];
  const selectedFolder = selectedFolderId
    ? folders.find((folder) => folder.id === selectedFolderId) ?? null
    : null;
  const childFolders = useMemo(
    () => getChildFolders(folders, selectedFolderId),
    [folders, selectedFolderId],
  );
  const scrollHeader = useMemo(() => (
    <>
      {childFolders.length > 0 && (
        <section
          style={{
            paddingInline: DASHBOARD_PANEL_INSET_PX,
            paddingBottom: DASHBOARD_ITEM_GAP_PX,
          }}
        >
          <div className="pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
            하위 폴더
          </div>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
            style={{ gap: DASHBOARD_ITEM_GAP_PX }}
          >
            {childFolders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                className="rounded-2xl border border-white/8 bg-[var(--lg-card)] px-3.5 py-3 text-left text-[12.5px] font-semibold shadow-[0_6px_22px_-16px_rgb(20_26_40_/_40%)] transition-[border-color,box-shadow] hover:border-accent-blue/35 hover:shadow-[0_12px_28px_-18px_rgb(10_30_70_/_50%)]"
                onClick={() => selectFolder(folder.id)}
              >
                <span className="block truncate text-foreground">{folder.name}</span>
                <small className="mt-1 block text-[11px] font-normal text-muted-foreground/75">
                  {catalog ? `${getFolderDirectChildCount(catalog, folder.id)}개 항목` : "항목 없음"}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}
      <div
        className="pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70"
        style={{ paddingInline: DASHBOARD_PANEL_INSET_PX }}
      >
        세션
      </div>
    </>
  ), [catalog, childFolders, selectFolder]);

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
    <div className="flex h-full min-h-0 flex-col">
      <SessionsTopBar
        workspaceViewMode={workspaceViewMode}
        onWorkspaceViewModeChange={setWorkspaceViewMode}
        onOpenFolderSettings={selectedFolder && onUpdateFolderSettings ? () => setSettingsOpen(true) : undefined}
      />
      <div className="min-h-0 flex-1">
        <FolderContents
          sessions={sessions}
          onMoveSessions={onMoveSessions}
          onRenameSession={onRenameSession}
          onContinueSession={onContinueSession}
          getContinueSessionDisabledReason={getContinueSessionDisabledReason}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          scrollHeader={scrollHeader}
        />
      </div>
      <FolderSettingsDialog
        folder={selectedFolder}
        folders={folders}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onConfirm={(settings) => {
          if (selectedFolder) void onUpdateFolderSettings?.(selectedFolder.id, settings);
          setSettingsOpen(false);
        }}
      />
    </div>
  );
}
