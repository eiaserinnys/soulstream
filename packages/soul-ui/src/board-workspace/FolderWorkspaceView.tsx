import type { CatalogBoardItem, CatalogFolder, FolderSettings, SessionSummary } from "../shared/types";
import { useEffect, useMemo, useState } from "react";
import { BookOpenCheck, ExternalLink } from "lucide-react";
import { FolderContents } from "../components/FolderContents";
import { FolderSettingsDialog } from "../components/FolderSettingsDialog";
import { SessionsTopBar } from "../components/SessionsTopBar";
import type { LoadMoreCallback } from "../components/load-more-guard";
import { Badge } from "../components/ui/badge";
import { DASHBOARD_CARD_GAP_PX, DASHBOARD_LIST_INSET_PX } from "../components/dashboard-spacing";
import { useDashboardStore } from "../stores/dashboard-store";
import { useTaskStore, type TaskSnapshot } from "../stores/task-store";
import {
  BoardWorkspaceView,
  type BoardWorkspaceViewProps,
  type CreateMarkdownDocumentInput,
  type CreateMarkdownDocumentResult,
} from "./BoardWorkspaceView";
import {
  boardItemBelongsToContainer,
  sessionIdsOwnedByOtherBoardContainer,
} from "./board-container-visibility";
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
  onMoveBoardItemToContainer?: BoardWorkspaceViewProps["onMoveBoardItemToContainer"];
  onCreateMarkdownDocument?: (
    input: CreateMarkdownDocumentInput,
  ) => Promise<CreateMarkdownDocumentResult>;
  onUploadBoardAsset?: BoardWorkspaceViewProps["onUploadBoardAsset"];
  onLoadMore?: LoadMoreCallback;
  hasMore?: boolean;
}

function boardItemBelongsToSelectedFolder(item: CatalogBoardItem, folderId: string | null): boolean {
  if (!folderId) return false;
  return boardItemBelongsToContainer(item, { kind: "folder", id: folderId });
}

function metadataText(item: CatalogBoardItem, key: string): string {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function metadataBoolean(item: CatalogBoardItem, key: string): boolean {
  return item.metadata?.[key] === true;
}

function folderTaskItems(
  catalog: { boardItems?: CatalogBoardItem[] } | null,
  folderId: string | null,
): CatalogBoardItem[] {
  return (catalog?.boardItems ?? [])
    .filter((item) =>
      item.itemType === "task" &&
      !metadataBoolean(item, "archived") &&
      boardItemBelongsToSelectedFolder(item, folderId),
    )
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
}

function filterFolderListSessions(
  sessions: SessionSummary[] | undefined,
  catalog: { boardItems?: CatalogBoardItem[] } | null,
  selectedFolderId: string | null,
): SessionSummary[] | undefined {
  if (!sessions) return sessions;
  const hiddenSessionIds = sessionIdsOwnedByOtherBoardContainer(
    catalog?.boardItems,
    selectedFolderId ? { kind: "folder", id: selectedFolderId } : null,
    selectedFolderId,
  );
  if (hiddenSessionIds.size === 0) return sessions;
  return sessions.filter((session) => !hiddenSessionIds.has(session.agentSessionId));
}

function taskProgress(snapshot: TaskSnapshot | null): { completed: number; total: number } | null {
  if (!snapshot) return null;
  let completed = 0;
  let total = 0;
  for (const item of snapshot.items) {
    if (item.archived || item.status === "cancelled") continue;
    total += 1;
    if (item.status === "completed") completed += 1;
  }
  return { completed, total };
}

function FolderTaskCard({
  item,
  parentFolderId,
  onOpenBoard,
}: {
  item: CatalogBoardItem;
  parentFolderId: string | null;
  onOpenBoard: (taskId: string, parentFolderId?: string | null) => void;
}) {
  const projection = useTaskStore((s) => s.byId[item.itemId]);
  const loadTask = useTaskStore((s) => s.loadTask);

  useEffect(() => {
    const controller = new AbortController();
    void loadTask(item.itemId, { signal: controller.signal }).catch(() => undefined);
    return () => controller.abort();
  }, [item.itemId, loadTask]);

  const snapshot = projection?.snapshot ?? null;
  if (snapshot?.task.archived) return null;

  const title = snapshot?.task.title || metadataText(item, "title") || "Task";
  const progress = taskProgress(snapshot);
  const completed = snapshot?.task.status === "completed";
  const badgeText = progress ? `${progress.completed}/${progress.total}` : completed ? "완료" : "업무";

  return (
    <button
      type="button"
      data-testid="folder-task-card"
      data-task-id={item.itemId}
      className="rounded-2xl border border-white/8 bg-[var(--lg-card)] px-3.5 py-3 text-left text-[12.5px] font-semibold shadow-[0_6px_22px_-16px_rgb(20_26_40_/_40%)] transition-[border-color,box-shadow] hover:border-accent-blue/35 hover:shadow-[0_12px_28px_-18px_rgb(10_30_70_/_50%)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/55"
      onClick={(event) => {
        event.stopPropagation();
        onOpenBoard(item.itemId, parentFolderId);
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <BookOpenCheck className="h-4 w-4 shrink-0 text-accent-blue" aria-hidden="true" />
        <span className="block min-w-0 flex-1 truncate text-foreground">{title}</span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </span>
      <span className="mt-1 flex items-center gap-1.5">
        <Badge
          variant={completed ? "success" : "outline"}
          size="sm"
          className="h-5 px-1.5 text-[10px]"
        >
          {badgeText}
        </Badge>
      </span>
    </button>
  );
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
  onMoveBoardItemToContainer,
  onCreateMarkdownDocument,
  onUploadBoardAsset,
  onLoadMore,
  hasMore,
}: FolderWorkspaceViewProps) {
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const catalog = useDashboardStore((s) => s.catalog);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const activeBoardContainer = useDashboardStore((s) => s.activeBoardContainer);
  const openTaskBoard = useDashboardStore((s) => s.openTaskBoard);
  const setBoardItemsForFolder = useDashboardStore((s) => s.setBoardItemsForFolder);
  const taskProjections = useTaskStore((s) => s.byId);
  const [workspaceViewMode, setWorkspaceViewMode] =
    useFolderWorkspaceViewMode(selectedFolderId);
  // 폴더의 리스트↔보드 토글은 항상 "폴더 보드"를 대상으로 한다. 업무 보드를
  // 열었던 흔적(activeBoardContainer=task)이 남아 있으면 폴더 컨테이너로
  // 되돌린다 — 업무 보드 재진입은 명시적 경로(오버뷰·업무 타일)만 사용.
  const handleWorkspaceViewModeChange = (mode: Parameters<typeof setWorkspaceViewMode>[0]) => {
    if (activeBoardContainer?.kind === "task" && selectedFolderId) {
      selectFolder(selectedFolderId);
    }
    setWorkspaceViewMode(mode);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 업무 보드는 폴더의 리스트/보드 선호와 무관한 컨테이너 뷰다 — 업무 컨테이너가
  // 활성인 동안은 항상 보드를 렌더한다 (오버뷰 "업무 보드 열기"가 리스트 선호
  // 폴더에서 세션 리스트로 떨어지던 결함 수정).
  const showBoard =
    workspaceViewMode === "board" || activeBoardContainer?.kind === "task";

  useEffect(() => {
    if (showBoard || !selectedFolderId) return;
    const controller = new AbortController();
    fetch(`/api/board-items?folder_id=${encodeURIComponent(selectedFolderId)}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (response.ok) return response.json();
        throw new Error("board items fetch failed");
      })
      .then((data) => {
        if (Array.isArray(data?.boardItems)) {
          setBoardItemsForFolder(selectedFolderId, data.boardItems);
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [selectedFolderId, setBoardItemsForFolder, showBoard]);

  const folders = catalog?.folders ?? [];
  const selectedFolder = selectedFolderId
    ? folders.find((folder) => folder.id === selectedFolderId) ?? null
    : null;
  const childFolders = useMemo(
    () => getChildFolders(folders, selectedFolderId),
    [folders, selectedFolderId],
  );
  const taskItems = useMemo(() => (
    folderTaskItems(catalog, selectedFolderId).filter((item) =>
      !taskProjections[item.itemId]?.snapshot?.task.archived
    )
  ), [catalog, taskProjections, selectedFolderId]);
  const visibleSessions = useMemo(
    () => filterFolderListSessions(sessions, catalog, selectedFolderId),
    [catalog, selectedFolderId, sessions],
  );
  const scrollHeader = useMemo(() => (
    <>
      {childFolders.length > 0 && (
        <section
          style={{
            paddingInline: DASHBOARD_LIST_INSET_PX,
            paddingBottom: DASHBOARD_CARD_GAP_PX,
          }}
        >
          <div className="pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
            하위 폴더
          </div>
          <div
            className="grid grid-cols-1 xl:grid-cols-2"
            style={{ gap: DASHBOARD_CARD_GAP_PX }}
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
      {taskItems.length > 0 && (
        <section
          data-testid="folder-task-section"
          style={{
            paddingInline: DASHBOARD_LIST_INSET_PX,
            paddingBottom: DASHBOARD_CARD_GAP_PX,
          }}
        >
          <div className="pb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
            업무
          </div>
          <div
            className="grid grid-cols-1 xl:grid-cols-2"
            style={{ gap: DASHBOARD_CARD_GAP_PX }}
          >
            {taskItems.map((item) => (
              <FolderTaskCard
                key={item.id}
                item={item}
                parentFolderId={selectedFolderId}
                onOpenBoard={openTaskBoard}
              />
            ))}
          </div>
        </section>
      )}
      <div
        className="pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70"
        style={{ paddingInline: DASHBOARD_LIST_INSET_PX }}
      >
        세션
      </div>
    </>
  ), [catalog, childFolders, openTaskBoard, taskItems, selectFolder, selectedFolderId]);

  if (showBoard) {
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
        onMoveBoardItemToContainer={onMoveBoardItemToContainer}
        onCreateMarkdownDocument={onCreateMarkdownDocument}
        onUploadBoardAsset={onUploadBoardAsset}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        workspaceViewMode="board"
        onWorkspaceViewModeChange={handleWorkspaceViewModeChange}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionsTopBar
        workspaceViewMode={workspaceViewMode}
        onWorkspaceViewModeChange={handleWorkspaceViewModeChange}
        onOpenFolderSettings={selectedFolder && onUpdateFolderSettings ? () => setSettingsOpen(true) : undefined}
      />
      <div className="min-h-0 flex-1">
        <FolderContents
          sessions={visibleSessions}
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
