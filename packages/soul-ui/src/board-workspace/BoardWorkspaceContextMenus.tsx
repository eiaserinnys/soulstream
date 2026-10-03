// Size exception: this legacy menu coordinator still owns every board-card dialog.
// Shared mutations are extracted as they are touched; splitting the coordinator is a separate migration.
import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, Copy, Folder, Frame, Hash, Maximize2, MessageSquarePlus, Minimize2, Pencil, SquarePen, Trash2 } from "lucide-react";

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
import { SessionMenuTrigger } from "../components/SessionMenuOwner";
import type { BoardWorkspaceItem } from "./board-workspace-items";
import type { BoardYjsRuntime } from "./board-yjs-client";

import { BoardRenameDialog, BoardMoveDialog } from "./BoardWorkspaceDialogViews";

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

export interface FolderMoveTarget {
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
  folderMoveTargets: FolderMoveTarget[];
  activeBoardDocumentId: string | null;
  boardYjsRuntime: BoardYjsRuntime | null;
  canCreateBoardItems?: boolean;
  canCreateSessions?: boolean;
  canCreateStructureItems?: boolean;
  onCloseCardContextMenu: () => void;
  onOpenCreateFolder: (position: { x: number; y: number }) => void;
  onOpenNewSession: (position: { x: number; y: number }) => void;
  onCreateMarkdown: (position: { x: number; y: number }) => void;
  onCreateFrame: (position: { x: number; y: number }) => void;
  onRenameFrame: (item: Extract<BoardWorkspaceItem, { type: "frame" }>, title: string) => void;
  onToggleFrameCollapsed: (item: Extract<BoardWorkspaceItem, { type: "frame" }>) => void;
  onDeleteFrame: (item: Extract<BoardWorkspaceItem, { type: "frame" }>) => void;
  onMoveBoardItemToFolder?: (
    item: MovableBoardWorkspaceItem,
    target: BoardContainerRef,
  ) => Promise<void>;
  onMarkdownDocumentDeleted?: (documentId: string, boardItemId: string) => void;
  onRequestMarkdownEdit?: (documentId: string) => void;
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
  folderMoveTargets,
  activeBoardDocumentId,
  boardYjsRuntime,
  canCreateBoardItems = true,
  canCreateSessions = true,
  canCreateStructureItems = true,
  onCloseCardContextMenu,
  onOpenCreateFolder,
  onOpenNewSession,
  onCreateMarkdown,
  onCreateFrame,
  onRenameFrame,
  onToggleFrameCollapsed,
  onDeleteFrame,
  onMoveBoardItemToFolder,
  onMarkdownDocumentDeleted,
  onRequestMarkdownEdit,
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
  const [moveFolderTarget, setMoveFolderTarget] = useState<{
    item: MovableBoardWorkspaceItem;
    selectedFolderId: string;
  } | null>(null);
  const [moveTaskError, setMoveTaskError] = useState("");
  const [moveFolderPending, setMoveFolderPending] = useState(false);

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
  const assetContextMenu =
    movableContextMenu && movableContextMenu.item.type === "asset"
      ? movableContextMenu
      : null;
  const customViewContextMenu =
    cardContextMenu?.item.type === "custom_view"
      ? { screenX: cardContextMenu.screenX, screenY: cardContextMenu.screenY, item: cardContextMenu.item }
      : null;
  const canMoveBoardItem = Boolean(onMoveBoardItemToFolder && boardContainer && resolvedBoardFolderId);

  const copyToClipboard = (text: string, label: string) => {
    onCloseCardContextMenu();
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      toastManager.add({ title: `${label} 복사 실패`, description: "클립보드를 사용할 수 없습니다.", type: "error" });
      return;
    }
    void clipboard.writeText(text).then(
      () => toastManager.add({ title: `${label} 복사됨`, type: "success" }),
      () => toastManager.add({ title: `${label} 복사 실패`, type: "error" }),
    );
  };

  // custom_view(Flux) 카드 삭제 = 보드 아이템(카드 배치) 제거를 반드시 Y.Doc 경유로
  // 수행한다. Flux 엔티티 자체는 보존되고 보드에서만 내려간다.
  const handleDeleteCustomView = (item: Extract<BoardWorkspaceItem, { type: "custom_view" }>) => {
    onCloseCardContextMenu();
    boardYjsRuntime?.deleteBoardItem(item.boardItemId);
    removeBoardItem(item.boardItemId);
    if (activeBoardDocumentId === item.customViewId) setActiveBoardDocument(null);
  };
  const availableFolderMoveTargets = folderMoveTargets.filter((target) => target.id !== boardContainer?.id);

  function openMoveBoardItemTarget(item: MovableBoardWorkspaceItem) {
    if (!onMoveBoardItemToFolder || !boardContainer || !resolvedBoardFolderId) return;
    onCloseCardContextMenu();
    setMoveTaskError("");
    setMoveFolderTarget({
      item,
      selectedFolderId: availableFolderMoveTargets[0]?.id ?? "",
    });
  }

  async function handleMoveBoardItem(
    item: MovableBoardWorkspaceItem,
    target: BoardContainerRef,
  ) {
    if (!onMoveBoardItemToFolder || moveFolderPending) return;
    setMoveFolderPending(true);
    try {
      setMoveTaskError("");
      await onMoveBoardItemToFolder(item, target);
      setMoveFolderTarget(null);
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
      setMoveFolderPending(false);
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

  // 🔴24: fixed-position 메뉴/다이얼로그를 document.body로 포털한다. 폴더 보드 스크롤러는
  // backdrop-filter(blur)를 걸어 스스로 fixed 자식의 containing block이 되고 overflow로
  // 잘라내 메뉴가 화면에서 사라졌다(폴더 보드는 필터가 없어 정상). 포털로 뷰포트 기준
  // 좌표(clientX/clientY)가 항상 올바르게 적용된다. 폴더 보드 동작은 그대로 유지된다.
  const menuTree = (
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
          {canCreateSessions ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => onOpenNewSession({ x: contextMenu.boardX, y: contextMenu.boardY })}
            >
              <MessageSquarePlus className="h-4 w-4" />
              새 세션 시작
            </button>
          ) : null}
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

      <SessionMenuTrigger
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
          className="fixed z-30 w-44 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: markdownContextMenu.screenX, top: markdownContextMenu.screenY }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              onRequestMarkdownEdit?.(markdownContextMenu.item.documentId);
              onCloseCardContextMenu();
            }}
          >
            <SquarePen className="h-4 w-4" />
            편집
          </button>
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
              다른 폴더로 이동...
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => copyToClipboard(markdownContextMenu.item.title, "제목")}
          >
            <Copy className="h-4 w-4" />
            제목 복사
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => copyToClipboard(markdownContextMenu.item.documentId, "ID")}
          >
            <Hash className="h-4 w-4" />
            ID 복사
          </button>
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

      {customViewContextMenu && (
        <div
          className="fixed z-30 w-44 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: customViewContextMenu.screenX, top: customViewContextMenu.screenY }}
        >
          {/* 🔴25: custom_view(Flux)엔 마크다운 편집기가 없어 "편집" 항목을 두지 않는다. */}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => copyToClipboard(customViewContextMenu.item.title, "제목")}
          >
            <Copy className="h-4 w-4" />
            제목 복사
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => copyToClipboard(customViewContextMenu.item.customViewId, "ID")}
          >
            <Hash className="h-4 w-4" />
            ID 복사
          </button>
          {canMoveBoardItem && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => openMoveBoardItemTarget(customViewContextMenu.item)}
            >
              <ArrowRightLeft className="h-4 w-4" />
              다른 폴더로 이동...
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
            onClick={() => handleDeleteCustomView(customViewContextMenu.item)}
          >
            <Trash2 className="h-4 w-4" />
            삭제
          </button>
        </div>
      )}

      {assetContextMenu && canMoveBoardItem && (
        <div
          className="fixed z-30 w-48 rounded-md border border-glass-border glass-strong glass-shadow-lg p-1"
          style={{ left: assetContextMenu.screenX, top: assetContextMenu.screenY }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => openMoveBoardItemTarget(assetContextMenu.item)}
          >
            <ArrowRightLeft className="h-4 w-4" />
            다른 폴더로 이동...
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
        mode="archive"
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
      {renameMarkdownTarget ? <BoardRenameDialog kind="markdown" value={renameMarkdownInput} error={renameMarkdownError} onChange={setRenameMarkdownInput} onClose={() => setRenameMarkdownTarget(null)} onSubmit={() => { void handleRenameMarkdown(); }}/> : null}
      {renameFolderTarget ? <BoardRenameDialog kind="folder" value={renameFolderInput} onChange={setRenameFolderInput} onClose={() => setRenameFolderTarget(null)} onSubmit={() => { void handleRenameFolder(); }}/> : null}
      {renameFrameTarget ? <BoardRenameDialog kind="frame" value={renameFrameInput} onChange={setRenameFrameInput} onClose={() => setRenameFrameTarget(null)} onSubmit={handleRenameFrame}/> : null}
      <BoardMoveDialog open={moveFolderTarget!==null} pending={moveFolderPending} error={moveTaskError} targets={availableFolderMoveTargets} selectedFolderId={moveFolderTarget?.selectedFolderId ?? ""} onSelect={id=>setMoveFolderTarget(current=>current?{...current,selectedFolderId:id}:current)} onClose={()=>setMoveFolderTarget(null)} onMove={id=>{if(moveFolderTarget)void handleMoveBoardItem(moveFolderTarget.item,{kind:"folder",id});}}/>

    </>
  );

  // 🔴29: document.body로 포털하면 앱 컨테이너의 color: var(--foreground) 상속을 잃어(body엔
  // color 규칙이 없다) 메뉴 글자가 브라우저 기본색으로 폴백된다 → 다크 배경에서 검정으로 안 보인다.
  // --foreground 변수 자체는 html.dark 스코프라 유효하므로, 포털 래퍼에 text-foreground를 줘 모든
  // 메뉴 항목이 테마 전경색을 상속하게 한다(🔴24의 body 포털 위치는 유지). text-destructive 등
  // 명시 색은 그대로 우선한다.
  if (typeof document === "undefined") return menuTree;
  return createPortal(<div className="text-foreground">{menuTree}</div>, document.body);
}

function isMovableBoardWorkspaceItem(item: BoardWorkspaceItem): item is MovableBoardWorkspaceItem {
  return item.type === "session" ||
    item.type === "markdown" ||
    item.type === "asset" ||
    item.type === "custom_view";
}
