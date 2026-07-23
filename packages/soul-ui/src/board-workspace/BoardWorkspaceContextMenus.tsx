// Size exception: this legacy menu coordinator still owns every board-card dialog.
// Shared mutations are extracted as they are touched; splitting the coordinator is a separate migration.
import { useState } from "react";
import { ArrowRightLeft, Folder, Frame, Maximize2, MessageSquarePlus, Minimize2, Pencil, SquarePen, Trash2 } from "lucide-react";

import type { BoardContainerRef, CatalogFolder, FolderSettings, SessionSummary } from "../shared/types";
import { isSystemFolderId } from "../shared/constants";
import { useDashboardStore } from "../stores/dashboard-store";
import { Button } from "../components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { toastManager } from "../components/ui/toast";
import { deleteMarkdownDocument, renameMarkdownDocument } from "../lib/markdown-document-operations";
import { MarkdownDeleteDialog } from "../components/MarkdownDeleteDialog";
import { FolderDialog } from "../components/FolderDialog";
import { FolderContextMenu, type FolderContextMenuTarget } from "../components/FolderContextMenu";
import { FolderSettingsDialog } from "../components/FolderSettingsDialog";
import { SessionContextMenu, type SessionContextMenuExtraAction } from "../components/SessionContextMenu";
import type { BoardWorkspaceItem } from "./board-workspace-items";
import type { BoardYjsRuntime } from "./board-yjs-client";

const BOARD_MODAL_BACKDROP_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[6px] backdrop-saturate-[1.2]";

export interface BoardContextMenuState {
  screenX: number;
  screenY: number;
  boardX: number;
  boardY: number;
}

export interface BoardCardContextMenuState {
  screenX: number;
  screenY: number;
  item: BoardWorkspaceItem;
}

export interface TaskMoveTarget {
  id: string;
  title: string;
}

type MovableBoardWorkspaceItem = Extract<
  BoardWorkspaceItem,
  { type: "session" | "markdown" | "asset" | "custom_view" }
>;

interface BoardWorkspaceContextMenusProps {
  contextMenu: BoardContextMenuState | null;
  cardContextMenu: BoardCardContextMenuState | null;
  displaySessions: SessionSummary[];
  folders: CatalogFolder[];
  boardContainer: BoardContainerRef | null;
  resolvedBoardFolderId: string | null;
  taskMoveTargets: TaskMoveTarget[];
  activeBoardDocumentId: string | null;
  boardYjsRuntime: BoardYjsRuntime | null;
  canCreateBoardItems?: boolean;
  canCreateStructureItems?: boolean;
  onCloseCardContextMenu: () => void;
  onOpenCreateFolder: (position: { x: number; y: number }) => void;
  onOpenNewSession: (position: { x: number; y: number }) => void;
  onCreateMarkdown: (position: { x: number; y: number }) => void;
  onCreateFrame: (position: { x: number; y: number }) => void;
  onRenameFrame: (item: Extract<BoardWorkspaceItem, { type: "frame" }>, title: string) => void;
  onToggleFrameCollapsed: (item: Extract<BoardWorkspaceItem, { type: "frame" }>) => void;
  onDeleteFrame: (item: Extract<BoardWorkspaceItem, { type: "frame" }>) => void;
  onMoveBoardItemToContainer?: (
    item: MovableBoardWorkspaceItem,
    target: BoardContainerRef,
  ) => Promise<void>;
  onMarkdownDocumentDeleted?: (documentId: string, boardItemId: string) => void;
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => Promise<void>;
  onRenameSession?: (sessionId: string, displayName: string | null) => Promise<void>;
  onDeleteSessions?: (sessionIds: string[]) => Promise<void>;
  onContinueSession?: (sessionId: string) => Promise<void>;
  getContinueSessionDisabledReason?: (sessionId: string) => string | null;
  onRenameFolder?: (folderId: string, name: string) => Promise<void> | void;
  onDeleteFolder?: (folderId: string) => Promise<void> | void;
  onUpdateFolderSettings?: (folderId: string, settings: FolderSettings) => Promise<void> | void;
}

export function BoardWorkspaceContextMenus({
  contextMenu,
  cardContextMenu,
  displaySessions,
  folders,
  boardContainer,
  resolvedBoardFolderId,
  taskMoveTargets,
  activeBoardDocumentId,
  boardYjsRuntime,
  canCreateBoardItems = true,
  canCreateStructureItems = true,
  onCloseCardContextMenu,
  onOpenCreateFolder,
  onOpenNewSession,
  onCreateMarkdown,
  onCreateFrame,
  onRenameFrame,
  onToggleFrameCollapsed,
  onDeleteFrame,
  onMoveBoardItemToContainer,
  onMarkdownDocumentDeleted,
  onMoveSessions,
  onRenameSession,
  onDeleteSessions,
  onContinueSession,
  getContinueSessionDisabledReason,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
}: BoardWorkspaceContextMenusProps) {
  const removeBoardItem = useDashboardStore((s) => s.removeBoardItem);
  const setActiveBoardDocument = useDashboardStore((s) => s.setActiveBoardDocument);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [settingsFolderTarget, setSettingsFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameFolderTarget, setRenameFolderTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameFolderInput, setRenameFolderInput] = useState("");
  const [renameMarkdownTarget, setRenameMarkdownTarget] = useState<{ documentId: string; title: string; version: number } | null>(null);
  const [renameMarkdownInput, setRenameMarkdownInput] = useState("");
  const [renameMarkdownError, setRenameMarkdownError] = useState("");
  const [deleteMarkdownTarget, setDeleteMarkdownTarget] = useState<{ boardItemId: string; documentId: string; title: string } | null>(null);
  const [deleteMarkdownPending, setDeleteMarkdownPending] = useState(false);
  const [deleteMarkdownError, setDeleteMarkdownError] = useState("");
  const [renameFrameTarget, setRenameFrameTarget] = useState<Extract<BoardWorkspaceItem, { type: "frame" }> | null>(null);
  const [renameFrameInput, setRenameFrameInput] = useState("");
  const [moveTaskTarget, setMoveTaskTarget] = useState<{
    item: MovableBoardWorkspaceItem;
    selectedTaskId: string;
  } | null>(null);
  const [moveTaskError, setMoveTaskError] = useState("");
  const [moveTaskPending, setMoveTaskPending] = useState(false);

  const folderContextTarget: FolderContextMenuTarget | null =
    cardContextMenu?.item.type === "folder"
      ? {
          x: cardContextMenu.screenX,
          y: cardContextMenu.screenY,
          folder: {
            id: cardContextMenu.item.folder.id,
            name: cardContextMenu.item.folder.name,
          },
        }
      : null;
  const markdownContextMenu =
    cardContextMenu?.item.type === "markdown"
      ? { screenX: cardContextMenu.screenX, screenY: cardContextMenu.screenY, item: cardContextMenu.item }
      : null;
  const frameContextMenu =
    cardContextMenu?.item.type === "frame"
      ? { screenX: cardContextMenu.screenX, screenY: cardContextMenu.screenY, item: cardContextMenu.item }
      : null;
  const movableContextMenu =
    cardContextMenu && isMovableBoardWorkspaceItem(cardContextMenu.item)
      ? { screenX: cardContextMenu.screenX, screenY: cardContextMenu.screenY, item: cardContextMenu.item }
      : null;
  const assetOrCustomViewContextMenu =
    movableContextMenu && (movableContextMenu.item.type === "asset" || movableContextMenu.item.type === "custom_view")
      ? movableContextMenu
      : null;
  const canMoveBoardItem = Boolean(onMoveBoardItemToContainer && boardContainer && resolvedBoardFolderId);
  const availableTaskMoveTargets = taskMoveTargets.filter((target) => (
    boardContainer?.kind !== "task" || target.id !== boardContainer.id
  ));

  const moveSessionActions: SessionContextMenuExtraAction[] =
    movableContextMenu?.item.type === "session" && canMoveBoardItem
      ? [{
          label: boardContainer?.kind === "task" ? "폴더 보드로 내보내기" : "업무 보드로 이동...",
          onClick: () => openMoveBoardItemTarget(movableContextMenu.item),
        }]
      : [];

  function openMoveBoardItemTarget(item: MovableBoardWorkspaceItem) {
    if (!onMoveBoardItemToContainer || !boardContainer || !resolvedBoardFolderId) return;
    onCloseCardContextMenu();
    if (boardContainer.kind === "task" && item.type !== "markdown") {
      void handleMoveBoardItem(item, { kind: "folder", id: resolvedBoardFolderId });
      return;
    }
    setMoveTaskError("");
    setMoveTaskTarget({
      item,
      selectedTaskId: availableTaskMoveTargets[0]?.id ?? "",
    });
  }

  async function handleMoveBoardItem(
    item: MovableBoardWorkspaceItem,
    target: BoardContainerRef,
  ) {
    if (!onMoveBoardItemToContainer || moveTaskPending) return;
    setMoveTaskPending(true);
    try {
      setMoveTaskError("");
      await onMoveBoardItemToContainer(item, target);
      setMoveTaskTarget(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMoveTaskError(message);
      toastManager.add({
        title: "보드 이동 실패",
        description: message,
        type: "error",
      });
      console.error("Board item container move failed:", err);
    } finally {
      setMoveTaskPending(false);
    }
  }

  const handleDeleteFolder = async () => {
    if (!deleteFolderTarget) return;
    if (isSystemFolderId(deleteFolderTarget.id)) {
      setDeleteFolderTarget(null);
      return;
    }
    try {
      await onDeleteFolder?.(deleteFolderTarget.id);
      setDeleteFolderTarget(null);
    } catch (err) {
      console.error("Folder deletion failed:", err);
    }
  };

  const handleRenameFolder = async () => {
    if (!renameFolderTarget) return;
    if (isSystemFolderId(renameFolderTarget.id)) {
      setRenameFolderTarget(null);
      return;
    }
    const name = renameFolderInput.trim();
    if (!name) return;
    try {
      await onRenameFolder?.(renameFolderTarget.id, name);
      setRenameFolderTarget(null);
    } catch (err) {
      console.error("Folder rename failed:", err);
    }
  };

  const handleRenameMarkdown = async () => {
    if (!renameMarkdownTarget) return;
    const title = renameMarkdownInput.trim() || "Untitled document";
    try {
      setRenameMarkdownError("");
      if (boardYjsRuntime) {
        boardYjsRuntime.updateMarkdownTitle(renameMarkdownTarget.documentId, title);
      } else {
        await renameMarkdownDocument({
          documentId: renameMarkdownTarget.documentId,
          title,
          expectedVersion: renameMarkdownTarget.version,
        });
      }
      setRenameMarkdownTarget(null);
    } catch (err) {
      setRenameMarkdownError(err instanceof Error ? err.message : "문서 이름을 바꾸지 못했습니다.");
      console.error("Markdown document rename failed:", err);
    }
  };

  const handleDeleteMarkdown = async () => {
    if (!deleteMarkdownTarget || deleteMarkdownPending) return;
    setDeleteMarkdownPending(true);
    setDeleteMarkdownError("");
    try {
      if (boardYjsRuntime?.isProviderBacked) {
        boardYjsRuntime.deleteMarkdownDocument(deleteMarkdownTarget.documentId);
      } else {
        await deleteMarkdownDocument(deleteMarkdownTarget.documentId);
        boardYjsRuntime?.deleteMarkdownDocument(deleteMarkdownTarget.documentId);
      }
      const boardItemId = deleteMarkdownTarget.boardItemId;
      removeBoardItem(boardItemId);
      if (activeBoardDocumentId === deleteMarkdownTarget.documentId) setActiveBoardDocument(null);
      onMarkdownDocumentDeleted?.(deleteMarkdownTarget.documentId, boardItemId);
      setDeleteMarkdownTarget(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "문서를 삭제하지 못했습니다.";
      setDeleteMarkdownError(message);
      toastManager.add({ title: "문서 삭제 실패", description: message, type: "error" });
      console.error("Markdown document delete failed:", err);
    } finally {
      setDeleteMarkdownPending(false);
    }
  };

  const handleRenameFrame = () => {
    if (!renameFrameTarget) return;
    const title = renameFrameInput.trim() || "Frame";
    onRenameFrame(renameFrameTarget, title);
    setRenameFrameTarget(null);
  };

  return (
    <>
      {contextMenu && canCreateBoardItems && (
        <div
          className="fixed z-30 w-44 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: contextMenu.screenX, top: contextMenu.screenY }}
        >
          {canCreateStructureItems && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => onOpenCreateFolder({ x: contextMenu.boardX, y: contextMenu.boardY })}
            >
              <Folder className="h-4 w-4" />
              폴더 추가
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => onOpenNewSession({ x: contextMenu.boardX, y: contextMenu.boardY })}
          >
            <MessageSquarePlus className="h-4 w-4" />
            새 세션 시작
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => onCreateMarkdown({ x: contextMenu.boardX, y: contextMenu.boardY })}
          >
            <SquarePen className="h-4 w-4" />
            새 문서
          </button>
          {canCreateStructureItems && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => onCreateFrame({ x: contextMenu.boardX, y: contextMenu.boardY })}
            >
              <Frame className="h-4 w-4" />
              프레임 추가
            </button>
          )}
        </div>
      )}

      <SessionContextMenu
        contextMenu={
          cardContextMenu?.item.type === "session"
            ? {
                x: cardContextMenu.screenX,
                y: cardContextMenu.screenY,
                sessionId: cardContextMenu.item.session.agentSessionId,
              }
            : null
        }
        onClose={onCloseCardContextMenu}
        onRenameSession={onRenameSession}
        onMoveSessions={onMoveSessions}
        onDeleteSessions={onDeleteSessions}
        onContinueSession={onContinueSession}
        getContinueSessionDisabledReason={getContinueSessionDisabledReason}
        getSessionName={(sessionId) =>
          displaySessions.find((session) => session.agentSessionId === sessionId)?.displayName ?? ""
        }
        extraActions={moveSessionActions}
        resolveSessionIds={(sessionId) => [sessionId]}
      />

      <FolderContextMenu
        target={folderContextTarget}
        onClose={onCloseCardContextMenu}
        onRename={(folder) => {
          if (isSystemFolderId(folder.id)) return;
          setRenameFolderTarget(folder);
          setRenameFolderInput(folder.name);
        }}
        onOpenSettings={(folder) => setSettingsFolderTarget(folder)}
        onDelete={(folder) => {
          if (isSystemFolderId(folder.id)) return;
          setDeleteFolderTarget(folder);
        }}
      />

      {markdownContextMenu && (
        <div
          className="fixed z-30 w-40 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: markdownContextMenu.screenX, top: markdownContextMenu.screenY }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setRenameMarkdownTarget({
                documentId: markdownContextMenu.item.documentId,
                title: markdownContextMenu.item.title,
                version: markdownContextMenu.item.version,
              });
              setRenameMarkdownInput(markdownContextMenu.item.title);
              setRenameMarkdownError("");
              onCloseCardContextMenu();
            }}
          >
            <Pencil className="h-4 w-4" />
            이름 변경
          </button>
          {canMoveBoardItem && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => openMoveBoardItemTarget(markdownContextMenu.item)}
            >
              <ArrowRightLeft className="h-4 w-4" />
              {boardContainer?.kind === "task" ? "다른 업무로 이동..." : "업무 보드로 이동..."}
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
            onClick={() => {
              setDeleteMarkdownTarget({
                boardItemId: markdownContextMenu.item.boardItemId,
                documentId: markdownContextMenu.item.documentId,
                title: markdownContextMenu.item.title,
              });
              setDeleteMarkdownError("");
              onCloseCardContextMenu();
            }}
          >
            <Trash2 className="h-4 w-4" />
            삭제
          </button>
        </div>
      )}

      {assetOrCustomViewContextMenu && canMoveBoardItem && (
        <div
          className="fixed z-30 w-48 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: assetOrCustomViewContextMenu.screenX, top: assetOrCustomViewContextMenu.screenY }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => openMoveBoardItemTarget(assetOrCustomViewContextMenu.item)}
          >
            <ArrowRightLeft className="h-4 w-4" />
            {boardContainer?.kind === "task" ? "폴더 보드로 내보내기" : "업무 보드로 이동..."}
          </button>
        </div>
      )}

      {frameContextMenu && (
        <div
          className="fixed z-30 w-40 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: frameContextMenu.screenX, top: frameContextMenu.screenY }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setRenameFrameTarget(frameContextMenu.item);
              setRenameFrameInput(frameContextMenu.item.title);
              onCloseCardContextMenu();
            }}
          >
            <Pencil className="h-4 w-4" />
            이름 변경
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              onToggleFrameCollapsed(frameContextMenu.item);
              onCloseCardContextMenu();
            }}
          >
            {frameContextMenu.item.collapsed ? (
              <Maximize2 className="h-4 w-4" />
            ) : (
              <Minimize2 className="h-4 w-4" />
            )}
            {frameContextMenu.item.collapsed ? "펼치기" : "접기"}
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
            onClick={() => {
              onDeleteFrame(frameContextMenu.item);
              onCloseCardContextMenu();
            }}
          >
            <Trash2 className="h-4 w-4" />
            삭제
          </button>
        </div>
      )}

      <FolderDialog
        mode="delete"
        open={!!deleteFolderTarget}
        onOpenChange={(open) => { if (!open) setDeleteFolderTarget(null); }}
        onConfirm={handleDeleteFolder}
        folderName={deleteFolderTarget?.name ?? ""}
      />
      <MarkdownDeleteDialog
        open={deleteMarkdownTarget !== null}
        title={deleteMarkdownTarget?.title ?? ""}
        pending={deleteMarkdownPending}
        error={deleteMarkdownError}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteMarkdownTarget(null);
            setDeleteMarkdownError("");
          }
        }}
        onConfirm={() => { void handleDeleteMarkdown(); }}
      />
      <FolderSettingsDialog
        folder={folders.find((folder) => folder.id === settingsFolderTarget?.id) ?? null}
        folders={folders}
        open={!!settingsFolderTarget}
        onOpenChange={(open) => { if (!open) setSettingsFolderTarget(null); }}
        onConfirm={(settings) => {
          if (settingsFolderTarget) void onUpdateFolderSettings?.(settingsFolderTarget.id, settings);
          setSettingsFolderTarget(null);
        }}
      />
      {renameMarkdownTarget && (
        <div className={BOARD_MODAL_BACKDROP_CLASS}>
          <form
            className="w-80 rounded-md border border-glass-border glass-strong glass-shadow-lg p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRenameMarkdown();
            }}
          >
            <label className="mb-2 block text-sm font-medium" htmlFor="board-markdown-rename-input">
              문서 이름
            </label>
            <input
              id="board-markdown-rename-input"
              value={renameMarkdownInput}
              onChange={(event) => setRenameMarkdownInput(event.target.value)}
              className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            {renameMarkdownError && (
              <p className="mb-3 text-xs text-destructive">{renameMarkdownError}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameMarkdownTarget(null)}>
                취소
              </Button>
              <Button type="submit">변경</Button>
            </div>
          </form>
        </div>
      )}
      {renameFolderTarget && (
        <div className={BOARD_MODAL_BACKDROP_CLASS}>
          <form
            className="w-80 rounded-md border border-glass-border glass-strong glass-shadow-lg p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRenameFolder();
            }}
          >
            <label className="mb-2 block text-sm font-medium" htmlFor="board-folder-rename-input">
              폴더 이름
            </label>
            <input
              id="board-folder-rename-input"
              value={renameFolderInput}
              onChange={(event) => setRenameFolderInput(event.target.value)}
              className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameFolderTarget(null)}>
                취소
              </Button>
              <Button type="submit" disabled={!renameFolderInput.trim()}>
                변경
              </Button>
            </div>
          </form>
        </div>
      )}
      {renameFrameTarget && (
        <div className={BOARD_MODAL_BACKDROP_CLASS}>
          <form
            className="w-80 rounded-md border border-glass-border glass-strong glass-shadow-lg p-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleRenameFrame();
            }}
          >
            <label className="mb-2 block text-sm font-medium" htmlFor="board-frame-rename-input">
              프레임 이름
            </label>
            <input
              id="board-frame-rename-input"
              value={renameFrameInput}
              onChange={(event) => setRenameFrameInput(event.target.value)}
              className="mb-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setRenameFrameTarget(null)}>
                취소
              </Button>
              <Button type="submit" disabled={!renameFrameInput.trim()}>
                변경
              </Button>
            </div>
          </form>
        </div>
      )}
      <Dialog
        open={moveTaskTarget !== null}
        onOpenChange={(open) => {
          if (!open && !moveTaskPending) setMoveTaskTarget(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          {moveTaskTarget ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!moveTaskTarget.selectedTaskId) return;
              void handleMoveBoardItem(moveTaskTarget.item, {
                kind: "task",
                id: moveTaskTarget.selectedTaskId,
              });
            }}
          >
            <DialogHeader><DialogTitle>다른 업무로 이동</DialogTitle></DialogHeader>
            <DialogPanel>
              <div id="board-task-move-target" className="flex max-h-64 flex-col gap-1 overflow-auto">
                {availableTaskMoveTargets.length > 0 ? (
                  availableTaskMoveTargets.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      disabled={moveTaskPending}
                      className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        moveTaskTarget.selectedTaskId === target.id
                          ? "bg-primary text-primary-foreground"
                          : "hover:bg-accent"
                      }`}
                      onClick={() =>
                        setMoveTaskTarget((current) =>
                          current ? { ...current, selectedTaskId: target.id } : current
                        )
                      }
                    >
                      {target.title}
                    </button>
                  ))
                ) : (
                  <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                    이동할 수 있는 업무가 없습니다.
                  </p>
                )}
              </div>
              {moveTaskError ? <p className="mt-3 text-xs text-destructive" role="alert">{moveTaskError}</p> : null}
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button type="button" variant="outline" disabled={moveTaskPending} onClick={() => setMoveTaskTarget(null)}>
                취소
              </Button>
              <Button type="submit" disabled={!moveTaskTarget.selectedTaskId || moveTaskPending}>
                {moveTaskPending ? "이동 중…" : "이동"}
              </Button>
            </DialogFooter>
          </form>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function isMovableBoardWorkspaceItem(item: BoardWorkspaceItem): item is MovableBoardWorkspaceItem {
  return item.type === "session" ||
    item.type === "markdown" ||
    item.type === "asset" ||
    item.type === "custom_view";
}
