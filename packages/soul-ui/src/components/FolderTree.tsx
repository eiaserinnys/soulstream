/**
 * FolderTree - 폴더 카탈로그 트리 컴포넌트
 *
 * 왼쪽 패널에서 폴더 목록을 표시하고 폴더 선택/생성/삭제를 관리한다.
 * 실제 API 호출은 props 콜백으로 위임한다 (호스트가 구현).
 *
 * DnD는 DashboardDndProvider(DndContext)에 위임한다:
 *  - 세션 드래그 → 폴더 드롭: FolderItem 내부 useDroppable
 *  - 폴더 재정렬: SortableContext + FolderItem(useSortable)
 *
 * 본 컴포넌트는 컨테이너 역할만 수행한다:
 *  - 다이얼로그/컨텍스트 메뉴 상태 관리
 *  - 폴더 정렬·세션 카운트 훅 연결
 *  - FeedItem / FolderItem 자식 렌더링
 */

import { useState, useCallback, type ReactNode } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDashboardStore } from "../stores/dashboard-store";
import { useSortedFolders } from "../hooks/useSortedFolders";
import { useFolderSessionStats } from "../hooks/useFolderSessionStats";
import { Button } from "./ui/button";
import { SYSTEM_FOLDERS } from "../shared/constants";
import { Plus } from "lucide-react";
import { getChildFolders } from "../board-workspace/board-workspace-helpers";
import { FolderDialog } from "./FolderDialog";
import { FolderSettingsDialog } from "./FolderSettingsDialog";
import { FolderSortButton } from "./FolderSortButton";
import { FeedItem } from "./FeedItem";
import { TasksItem } from "./TasksItem";
import { FolderItem } from "./FolderItem";
import { FolderContextMenu, type FolderContextMenuTarget } from "./FolderContextMenu";
import type { FolderSettings } from "../shared/types";
import {
  readFolderTreeExpandedState,
  writeFolderTreeExpandedState,
} from "./folder-tree-expansion";

const SYSTEM_FOLDER_NAMES: Set<string> = new Set(Object.values(SYSTEM_FOLDERS));

function folderSortKey(name: string): string {
  return (
    name.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "").trim()
    || name
  );
}

export interface FolderTreeProps {
  onMoveSessions?: (sessionIds: string[], targetFolderId: string | null) => void;
  onCreateFolder?: (name: string) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onUpdateFolderSettings?: (folderId: string, settings: FolderSettings) => void;
  /** 폴더 순서 변경 완료 콜백 (사용자 지정 DnD 모드). orderedFolderIds는 재정렬된 일반 폴더 ID 배열 */
  onReorderFolders?: (orderedFolderIds: string[]) => Promise<void>;
  /**
   * 폴더별 세션 수 (서버 집계값).
   * 제공되면 sessions 배열 필터링 대신 이 값을 우선 사용합니다.
   * 인피니트 스크롤로 부분 로드된 경우에도 정확한 수를 표시합니다.
   */
  folderCounts?: Record<string, number>;
}

export function FolderTree({
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  folderCounts,
}: FolderTreeProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const folderSortMode = useDashboardStore((s) => s.folderSortMode);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragOverId] = useState<string | null>(null); // isOver는 useDroppable에서 관리
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<FolderContextMenuTarget | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<{ id: string; name: string } | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  const allFolders = catalog?.folders ?? [];

  const { sortedNormalFolders, sortedNormalFolderIds, systemFolders } = useSortedFolders(allFolders);
  const { getDirectChildCount, getUnreadCount, runningFolderIds } = useFolderSessionStats(folderCounts);

  const handleCreateFolder = async (name: string) => {
    try {
      await onCreateFolder?.(name.trim());
      setCreateDialogOpen(false);
    } catch {
      // 에러는 호스트 콜백에서 처리
    }
  };

  const handleDeleteFolder = async () => {
    if (!deleteTarget) return;
    try {
      await onDeleteFolder?.(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      // 에러는 호스트 콜백에서 처리
    }
  };

  const handleDoubleClick = (folderId: string, currentName: string) => {
    setEditingId(folderId);
    setEditName(currentName);
  };

  const handleRenameSubmit = async (folderId: string) => {
    if (editName.trim()) {
      await onRenameFolder?.(folderId, editName.trim());
    }
    setEditingId(null);
  };

  /** 폴더 선택 — 자동 세션 선택은 FolderContents의 useEffect(!isMobile 조건)가 처리한다 */
  const handleSelectFolder = useCallback((folderId: string | null) => {
    selectFolder(folderId);
  }, [selectFolder]);

  const storage = typeof window === "undefined" ? undefined : window.localStorage;

  const isFolderExpanded = useCallback((folderId: string) => {
    return expandedFolders[folderId]
      ?? readFolderTreeExpandedState(storage, folderId);
  }, [expandedFolders, storage]);

  const toggleFolderExpanded = useCallback((folderId: string) => {
    const next = !isFolderExpanded(folderId);
    writeFolderTreeExpandedState(storage, folderId, next);
    setExpandedFolders((prev) => ({ ...prev, [folderId]: next }));
  }, [isFolderExpanded, storage]);

  const sortTreeFolders = useCallback((folders: typeof allFolders) => {
    const normal = folders.filter((f) => !SYSTEM_FOLDER_NAMES.has(f.name));
    switch (folderSortMode) {
      case "name-asc":
        return [...normal].sort((a, b) => folderSortKey(a.name).localeCompare(folderSortKey(b.name)));
      case "name-desc":
        return [...normal].sort((a, b) => folderSortKey(b.name).localeCompare(folderSortKey(a.name)));
      case "created-desc":
        return [...normal].sort((a, b) =>
          new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
        );
      case "created-asc":
        return [...normal].sort((a, b) =>
          new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
        );
      case "custom":
      default:
        return [...normal].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    }
  }, [folderSortMode]);

  const renderFolderItem = (folder: typeof allFolders[number], depth = 0): ReactNode => {
    const isSystem = SYSTEM_FOLDER_NAMES.has(folder.name);
    const isDraggableFolder = depth === 0 && folderSortMode === "custom" && !isSystem;
    const childFolders = sortTreeFolders(getChildFolders(allFolders, folder.id));
    const hasChildren = childFolders.length > 0;
    const isExpanded = hasChildren && isFolderExpanded(folder.id);
    return (
      <div key={folder.id}>
        <FolderItem
          folder={folder}
          isSystem={isSystem}
          isDraggableFolder={isDraggableFolder}
          sortedNormalFolderIds={sortedNormalFolderIds}
          isSelected={viewMode === "folder" && selectedFolderId === folder.id}
          isEditingThis={editingId === folder.id}
          editName={editName}
          dragOverId={dragOverId}
          unreadCount={getUnreadCount(folder.id)}
          sessionCount={getDirectChildCount(folder.id)}
          isRunning={runningFolderIds.has(folder.id)}
          depth={depth}
          hasChildren={hasChildren}
          isExpanded={isExpanded}
          onToggleExpanded={() => toggleFolderExpanded(folder.id)}
          onSelect={() => handleSelectFolder(folder.id)}
          onDoubleClick={() => handleDoubleClick(folder.id, folder.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, folder: { id: folder.id, name: folder.name } });
          }}
          onEditChange={setEditName}
          onEditSubmit={() => handleRenameSubmit(folder.id)}
          onEditCancel={() => setEditingId(null)}
        />
        {isExpanded && childFolders.map((child) => renderFolderItem(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-semibold">Folders</span>
        <div className="flex items-center gap-0.5">
          <FolderSortButton />
          <Button variant="ghost" size="icon" onClick={() => setCreateDialogOpen(true)} title="New folder">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        <FeedItem />
        <TasksItem />

        <div className="border-t border-border my-1 mx-3" />

        {/* 일반 폴더 — SortableContext로 재정렬 가능 */}
        <SortableContext items={sortedNormalFolderIds} strategy={verticalListSortingStrategy}>
          {sortedNormalFolders.map((folder) => renderFolderItem(folder, 0))}
        </SortableContext>

        {/* 구분선 (일반 폴더가 1개 이상일 때만) */}
        {sortedNormalFolders.length > 0 && (
          <div className="border-t border-border my-1 mx-3" />
        )}

        {/* 시스템 폴더 */}
        {systemFolders.map((folder) => renderFolderItem(folder, 0))}
      </div>

      <FolderDialog
        mode="create"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onConfirm={handleCreateFolder}
      />
      <FolderDialog
        mode="delete"
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        onConfirm={handleDeleteFolder}
        folderName={deleteTarget?.name ?? ""}
      />
      <FolderSettingsDialog
        folder={catalog?.folders.find((f) => f.id === settingsTarget?.id) ?? null}
        folders={catalog?.folders ?? []}
        open={!!settingsTarget}
        onOpenChange={(open) => { if (!open) setSettingsTarget(null); }}
        onConfirm={(settings) => {
          if (settingsTarget) onUpdateFolderSettings?.(settingsTarget.id, settings);
          setSettingsTarget(null);
        }}
      />
      <FolderContextMenu
        target={contextMenu}
        onClose={() => setContextMenu(null)}
        onRename={(folder) => handleDoubleClick(folder.id, folder.name)}
        onOpenSettings={(folder) => setSettingsTarget(folder)}
        onDelete={(folder) => setDeleteTarget(folder)}
      />
    </div>
  );
}
