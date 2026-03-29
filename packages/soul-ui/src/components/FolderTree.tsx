/**
 * FolderTree - 폴더 카탈로그 트리 컴포넌트
 *
 * 왼쪽 패널에서 폴더 목록을 표시하고 폴더 선택/생성/삭제를 관리한다.
 * 실제 API 호출은 props 콜백으로 위임한다 (호스트가 구현).
 */

import { useState, useCallback, useMemo } from "react";
import { useDashboardStore, isSessionUnread } from "../stores/dashboard-store";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";
import { SYSTEM_FOLDERS } from "../shared/constants";
import { Plus, Newspaper, GripVertical } from "lucide-react";
import { FolderDialog } from "./FolderDialog";
import { FolderSettingsDialog } from "./FolderSettingsDialog";
import { FolderSortButton } from "./FolderSortButton";
import type { FolderSettings } from "../shared/types";

const SYSTEM_FOLDER_NAMES: Set<string> = new Set(Object.values(SYSTEM_FOLDERS));

/** 이름 정렬 키 — 앞쪽 이모지+공백 제거 후 텍스트 반환 */
function sortKey(name: string): string {
  return name.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, '').trim() || name;
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
  onMoveSessions,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onUpdateFolderSettings,
  onReorderFolders,
  folderCounts,
}: FolderTreeProps) {
  const catalog = useDashboardStore((s) => s.catalog);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);
  const selectedFolderId = useDashboardStore((s) => s.selectedFolderId);
  const selectFolder = useDashboardStore((s) => s.selectFolder);
  const sessions = useDashboardStore((s) => s.sessions);
  const viewMode = useDashboardStore((s) => s.viewMode);
  const selectFeed = useDashboardStore((s) => s.selectFeed);
  const getFeedSessions = useDashboardStore((s) => s.getFeedSessions);
  const folderSortMode = useDashboardStore((s) => s.folderSortMode);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; folder: { id: string; name: string } } | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<{ id: string; name: string } | null>(null);

  const allFolders = catalog?.folders ?? [];

  /** 정렬된 일반 폴더 목록 */
  const sortedNormalFolders = useMemo(() => {
    const normal = allFolders.filter((f) => !SYSTEM_FOLDER_NAMES.has(f.name));
    switch (folderSortMode) {
      case "name-asc":
        return [...normal].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
      case "name-desc":
        return [...normal].sort((a, b) => sortKey(b.name).localeCompare(sortKey(a.name)));
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
        return [...normal].sort((a, b) => a.sortOrder - b.sortOrder);
    }
  }, [allFolders, folderSortMode, catalogVersion]);

  const systemFolders = useMemo(
    () => allFolders.filter((f) => SYSTEM_FOLDER_NAMES.has(f.name)),
    [allFolders, catalogVersion],
  );

  const handleDrop = useCallback(async (folderId: string | null, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(null);
    // 폴더 재정렬 DnD가 아닌 경우에만 세션 이동 처리
    if (!e.dataTransfer.types.includes("application/x-folder-reorder")) {
      try {
        const ids: string[] = JSON.parse(e.dataTransfer.getData("text/plain"));
        onMoveSessions?.(ids, folderId);
      } catch {
        // JSON parse error — ignore
      }
    }
  }, [onMoveSessions]);

  const handleFolderReorderDrop = useCallback(async (targetFolderId: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(null);
    const draggedId = e.dataTransfer.getData("application/x-folder-reorder");
    setDragFolderId(null);
    if (!draggedId || draggedId === targetFolderId) return;
    // 일반 폴더 순서만 재계산 (시스템 폴더 제외)
    const currentOrder = sortedNormalFolders.map((f) => f.id);
    const withoutDragged = currentOrder.filter((id) => id !== draggedId);
    const targetIdx = withoutDragged.indexOf(targetFolderId);
    if (targetIdx === -1) {
      withoutDragged.push(draggedId);
    } else {
      withoutDragged.splice(targetIdx, 0, draggedId);
    }
    await onReorderFolders?.(withoutDragged);
  }, [onReorderFolders, sortedNormalFolders]);

  const getSessionCount = useCallback(
    (folderId: string | null) => {
      // folderCounts prop이 있으면 서버 집계값 우선 사용 (부분 로드 상황에서 정확성 보장)
      if (folderCounts) {
        const key = folderId === null ? "null" : folderId;
        return folderCounts[key] ?? 0;
      }
      // fallback: sessions 배열 직접 필터링
      if (!catalog) return 0;
      return sessions.filter((s) => {
        const assignment = catalog.sessions[s.agentSessionId];
        if (folderId === null) {
          return !assignment || assignment.folderId === null;
        }
        return assignment?.folderId === folderId;
      }).length;
    },
    [catalog, sessions, catalogVersion, folderCounts],
  );

  const getUnreadCount = useCallback(
    (folderId: string | null) => {
      if (!catalog) return 0;
      return sessions.filter((s) => {
        const assignment = catalog.sessions[s.agentSessionId];
        if (folderId === null) {
          return (!assignment || assignment.folderId === null) && isSessionUnread(s);
        }
        return assignment?.folderId === folderId && isSessionUnread(s);
      }).length;
    },
    [catalog, sessions, catalogVersion],
  );

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

  const runningFolderIds = useMemo(() => {
    if (!catalog) return new Set<string>();
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.status === "running") {
        const fid = catalog.sessions[s.agentSessionId]?.folderId;
        if (fid) set.add(fid);
      }
    }
    return set;
  }, [catalog, sessions, catalogVersion]);

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

  /** 폴더 선택 — 세션 자동 선택 로직은 스토어의 selectFolder 액션이 담당 */
  const handleSelectFolder = useCallback((folderId: string | null) => {
    selectFolder(folderId);
  }, [selectFolder]);

  /** 피드 미읽음 카운트 */
  const feedUnreadCount = useMemo(() => {
    const feed = getFeedSessions();
    return feed.filter(isSessionUnread).length;
  }, [sessions, getFeedSessions, catalogVersion]);

  // normalFolders alias (기존 코드와의 호환성 유지)
  const normalFolders = sortedNormalFolders;

  const renderFolder = (folder: typeof allFolders[number]) => {
    const isSystem = SYSTEM_FOLDER_NAMES.has(folder.name);
    const isDraggableFolder = folderSortMode === "custom" && !isSystem;
    return (
    <div
      key={folder.id}
      draggable={isDraggableFolder}
      className={cn(
        "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50 group select-none",
        viewMode === "folder" && selectedFolderId === folder.id && "bg-accent text-accent-foreground",
        dragOverId === folder.id && "ring-2 ring-primary",
        isDraggableFolder && dragFolderId === folder.id && "opacity-50",
      )}
      onClick={() => handleSelectFolder(folder.id)}
      onDoubleClick={() => handleDoubleClick(folder.id, folder.name)}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, folder: { id: folder.id, name: folder.name } });
      }}
      onDragStart={isDraggableFolder ? (e) => {
        e.dataTransfer.setData("application/x-folder-reorder", folder.id);
        e.dataTransfer.effectAllowed = "move";
        setDragFolderId(folder.id);
      } : undefined}
      onDragEnd={isDraggableFolder ? () => setDragFolderId(null) : undefined}
      onDragOver={(e) => { e.preventDefault(); setDragOverId(folder.id); }}
      onDragLeave={() => setDragOverId(null)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("application/x-folder-reorder") && isDraggableFolder) {
          handleFolderReorderDrop(folder.id, e);
        } else {
          handleDrop(folder.id, e);
        }
      }}
    >
      {editingId === folder.id ? (
        <input
          autoFocus
          className="flex-1 bg-transparent border-b border-primary outline-none text-sm"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={() => handleRenameSubmit(folder.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleRenameSubmit(folder.id);
            if (e.key === "Escape") setEditingId(null);
          }}
        />
      ) : (
        <div className="flex items-center gap-1.5 min-w-0">
          {isDraggableFolder && (
            <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-60 cursor-grab" />
          )}
          <span className="truncate">{folder.name}</span>
          {runningFolderIds.has(folder.id) && (
            <Spinner className="h-3 w-3 shrink-0" />
          )}
        </div>
      )}
      {(() => {
        const unreadCount = getUnreadCount(folder.id);
        return unreadCount > 0 ? (
          <Badge variant="destructive" className="ml-2 text-xs font-bold">
            {unreadCount}
          </Badge>
        ) : (
          <Badge variant="secondary" className="ml-2 text-xs">
            {getSessionCount(folder.id)}
          </Badge>
        );
      })()}
    </div>
  );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">Folders</span>
        <div className="flex items-center gap-0.5">
          <FolderSortButton />
          <Button variant="ghost" size="icon" onClick={() => setCreateDialogOpen(true)} title="New folder">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* 📰 피드 */}
        <div
          className={cn(
            "flex items-center justify-between px-3 py-1.5 cursor-pointer text-sm hover:bg-accent/50",
            viewMode === "feed" && "bg-accent text-accent-foreground",
          )}
          onClick={selectFeed}
        >
          <div className="flex items-center gap-1.5">
            <Newspaper className="h-3.5 w-3.5" />
            <span>피드</span>
          </div>
          {feedUnreadCount > 0 ? (
            <Badge variant="destructive" className="ml-2 text-xs font-bold">
              {feedUnreadCount}
            </Badge>
          ) : null}
        </div>

        {/* 구분선 */}
        <div className="border-t border-border my-1 mx-3" />

        {/* 일반 폴더 */}
        {normalFolders.map(renderFolder)}

        {/* 구분선 (일반 폴더가 1개 이상일 때만) */}
        {normalFolders.length > 0 && (
          <div className="border-t border-border my-1 mx-3" />
        )}

        {/* 시스템 폴더 */}
        {systemFolders.map(renderFolder)}
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
        open={!!settingsTarget}
        onOpenChange={(open) => { if (!open) setSettingsTarget(null); }}
        onConfirm={(settings) => {
          if (settingsTarget) onUpdateFolderSettings?.(settingsTarget.id, settings);
          setSettingsTarget(null);
        }}
      />
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-md border border-border bg-popover shadow-md py-1"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseLeave={() => setContextMenu(null)}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50"
            onClick={() => {
              handleDoubleClick(contextMenu.folder.id, contextMenu.folder.name);
              setContextMenu(null);
            }}
          >
            이름 변경
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50"
            onClick={() => {
              setSettingsTarget({ id: contextMenu.folder.id, name: contextMenu.folder.name });
              setContextMenu(null);
            }}
          >
            설정
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent/50 text-destructive"
            onClick={() => {
              setDeleteTarget({ id: contextMenu.folder.id, name: contextMenu.folder.name });
              setContextMenu(null);
            }}
          >
            삭제
          </button>
        </div>
      )}
    </div>
  );
}
